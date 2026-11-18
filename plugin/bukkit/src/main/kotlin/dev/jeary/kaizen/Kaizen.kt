package dev.jeary.kaizen

import dev.jeary.kaizen.config.ConfigException
import dev.jeary.kaizen.config.Messages
import dev.jeary.kaizen.config.Settings
import dev.jeary.kaizen.core.apply.AtomicFiles
import dev.jeary.kaizen.core.apply.ApplyTransaction
import dev.jeary.kaizen.core.apply.BackupStore
import dev.jeary.kaizen.core.crypto.OwnerSecret
import dev.jeary.kaizen.core.files.ConfigCollector
import dev.jeary.kaizen.core.files.PathGuard
import dev.jeary.kaizen.core.http.KaizenApi
import dev.jeary.kaizen.core.protocol.ServerInfo
import dev.jeary.kaizen.core.service.ApplyService
import dev.jeary.kaizen.core.service.EditorService
import dev.jeary.kaizen.core.session.SessionStore
import dev.jeary.kaizen.platform.MainThreadDispatcher
import dev.jeary.kaizen.platform.Messenger
import dev.jeary.kaizen.platform.PluginScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.bukkit.Bukkit
import org.bukkit.configuration.file.YamlConfiguration
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import java.util.logging.Level

/**
 * Everything the plugin holds at runtime. Services that depend on config.yml are rebuilt on
 * `/kaizen reload`. The owner secret, sessions and backups stay as they are.
 */
class Kaizen(val plugin: KaizenPlugin) {
    val logger = plugin.logger
    val scope = PluginScope(plugin)
    val main = MainThreadDispatcher(plugin)
    private val dataDir: Path = plugin.dataFolder.toPath()

    /** The server folder: plugins/Kaizen/../.. */
    val serverRoot: Path = plugin.dataFolder.absoluteFile.toPath().parent.parent

    val owner: OwnerSecret = loadOwnerSecret()
    val sessions = SessionStore(dataDir.resolve("data").resolve("sessions"))
    val backups = BackupStore(dataDir.resolve("backups"))
    val confirmations = Confirmations()

    @Volatile lateinit var settings: Settings
        private set

    @Volatile lateinit var messenger: Messenger
        private set

    @Volatile lateinit var guard: PathGuard
        private set

    @Volatile lateinit var collector: ConfigCollector
        private set

    @Volatile lateinit var editor: EditorService
        private set

    @Volatile lateinit var applier: ApplyService
        private set

    val serverInfo: ServerInfo by lazy {
        ServerInfo("${Bukkit.getName()} ${Bukkit.getBukkitVersion().substringBefore('-')}", plugin.description.version)
    }

    /** Loads config.yml and messages.yml. Throws [ConfigException] (nothing changes) if either is invalid. */
    fun load() {
        plugin.saveDefaultConfig()
        if (!File(plugin.dataFolder, Messages.FILE).exists()) plugin.saveResource(Messages.FILE, false)

        val configYaml = YamlConfiguration()
        val messagesYaml = YamlConfiguration()
        val errors = mutableListOf<dev.jeary.kaizen.config.ConfigError>()
        try {
            configYaml.load(File(plugin.dataFolder, Settings.FILE))
        } catch (e: Exception) {
            errors += dev.jeary.kaizen.config.ConfigError(Settings.FILE, "(file)", "not valid YAML: ${e.message?.lineSequence()?.firstOrNull()}")
        }
        try {
            messagesYaml.load(File(plugin.dataFolder, Messages.FILE))
        } catch (e: Exception) {
            errors += dev.jeary.kaizen.config.ConfigError(Messages.FILE, "(file)", "not valid YAML: ${e.message?.lineSequence()?.firstOrNull()}")
        }
        if (errors.isNotEmpty()) throw ConfigException(errors)

        val newSettings = runCatching { Settings.load(configYaml) }
        val newMessages = runCatching { Messages.load(messagesYaml, Messages.defaults()) }
        val problems = listOfNotNull(newSettings.exceptionOrNull(), newMessages.exceptionOrNull())
            .flatMap { (it as? ConfigException)?.errors ?: throw it }
        if (problems.isNotEmpty()) throw ConfigException(problems)

        apply(newSettings.getOrThrow(), newMessages.getOrThrow())
    }

    private fun apply(settings: Settings, messages: Messages) {
        this.settings = settings
        if (::messenger.isInitialized) messenger.messages = messages else messenger = Messenger(plugin, messages)
        guard = PathGuard(serverRoot, settings.filePolicy)
        collector = ConfigCollector(guard)
        val api = KaizenApi(settings.webUrl, "Kaizen/${plugin.description.version} (+https://github.com/jeary-dev/Kaizen)", settings.httpTimeout)
        editor = EditorService(collector, api, sessions, owner, settings.webUrl)
        applier = ApplyService(api, sessions, owner, guard, ApplyTransaction(backups))
    }

    fun startHousekeeping() {
        scope.launch(Dispatchers.IO) {
            while (isActive) {
                try {
                    val now = Instant.now()
                    sessions.prune(now)
                    backups.prune(now, settings.backupKeep, settings.backupMaxAge)
                    confirmations.prune(now)
                } catch (e: Exception) {
                    logger.log(Level.WARNING, "Housekeeping failed: ${e.message}")
                }
                delay(10 * 60 * 1000L)
            }
        }
    }

    fun shutdown() {
        scope.shutdown()
        if (::messenger.isInitialized) messenger.close()
    }

    /**
     * The per-install owner secret (protocol §2). It proves to the editor server that this server
     * created a session. It is stored owner-readable only and never logged.
     */
    private fun loadOwnerSecret(): OwnerSecret {
        val file = dataDir.resolve("data").resolve("owner.secret")
        if (Files.isRegularFile(file)) {
            OwnerSecret.parse(Files.readString(file))?.let { return it }
            logger.warning("data/owner.secret was unreadable; generating a new one (open editor links stop working)")
        }
        Files.createDirectories(file.parent)
        val secret = OwnerSecret.generate()
        AtomicFiles.write(file, secret.bearer.toByteArray(), private = true)
        return secret
    }
}
