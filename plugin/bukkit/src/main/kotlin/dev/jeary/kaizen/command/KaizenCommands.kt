package dev.jeary.kaizen.command

import dev.jeary.kaizen.Kaizen
import dev.jeary.kaizen.config.ConfigException
import dev.jeary.kaizen.core.apply.ApplyFailedException
import dev.jeary.kaizen.core.files.Scope
import dev.jeary.kaizen.core.http.ApiException
import dev.jeary.kaizen.core.protocol.ProtocolException
import dev.jeary.kaizen.core.protocol.Reason
import dev.jeary.kaizen.core.service.KaizenException
import dev.jeary.kaizen.core.service.PreparedApply
import dev.jeary.kaizen.platform.Messenger.Companion.arg
import dev.jeary.kaizen.platform.Messenger.Companion.tag
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.bukkit.command.CommandSender
import org.bukkit.command.ConsoleCommandSender
import org.bukkit.entity.Player
import org.incendo.cloud.bukkit.CloudBukkitCapabilities
import org.incendo.cloud.exception.ArgumentParseException
import org.incendo.cloud.exception.CommandExecutionException
import org.incendo.cloud.exception.InvalidSyntaxException
import org.incendo.cloud.exception.NoPermissionException
import org.incendo.cloud.execution.ExecutionCoordinator
import org.incendo.cloud.paper.LegacyPaperCommandManager
import org.incendo.cloud.parser.standard.StringParser.quotedStringParser
import org.incendo.cloud.parser.standard.StringParser.stringParser
import org.incendo.cloud.suggestion.SuggestionProvider
import java.time.Duration
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import java.util.logging.Level

/**
 * `/kaizen` (alias `/kz`). Every argument is a single plain word, which Brigadier on Paper
 * accepts as-is, and apply codes are pure letters and digits.
 */
class KaizenCommands(private val k: Kaizen) {
    private val manager = LegacyPaperCommandManager.createNative(k.plugin, ExecutionCoordinator.simpleCoordinator())
    private val messenger get() = k.messenger

    /** One request at a time per sender; one write at a time for the whole server. */
    private val busy = ConcurrentHashMap.newKeySet<String>()
    private val lastEditor = ConcurrentHashMap<String, Instant>()
    private val writeLock = Mutex()

    fun register() {
        when {
            manager.hasCapability(CloudBukkitCapabilities.NATIVE_BRIGADIER) -> runCatching { manager.registerBrigadier() }
            manager.hasCapability(CloudBukkitCapabilities.ASYNCHRONOUS_COMPLETION) -> manager.registerAsynchronousCompletions()
        }
        registerExceptionHandlers()

        val root = manager.commandBuilder("kaizen", "kz")

        manager.command(
            root.literal("editor")
                .permission("kaizen.command.editor")
                .optional("target", quotedStringParser(), SuggestionProvider.blockingStrings { _, _ ->
                    listOf("all", "server") + runCatching { k.collector.pluginFolders() }.getOrDefault(emptyList())
                })
                .handler { ctx -> editor(ctx.sender(), ctx.getOrDefault("target", "all")) },
        )
        manager.command(
            root.literal("apply")
                .permission("kaizen.command.apply")
                .required("code", stringParser())
                .handler { ctx -> apply(ctx.sender(), ctx.get("code")) },
        )
        manager.command(
            root.literal("confirm")
                .permission("kaizen.command.apply")
                .required("token", stringParser())
                .handler { ctx -> confirm(ctx.sender(), ctx.get("token")) },
        )
        manager.command(
            root.literal("cancel")
                .permission("kaizen.command.apply")
                .required("token", stringParser())
                .handler { ctx -> cancel(ctx.sender(), ctx.get("token")) },
        )
        manager.command(
            root.literal("reload")
                .permission("kaizen.command.reload")
                .handler { ctx -> reload(ctx.sender()) },
        )
    }

    // ---------------------------------------------------------------------------------------------

    private fun editor(sender: CommandSender, target: String) = launch(sender) {
        val key = senderKey(sender)
        val last = lastEditor[key]
        if (last != null && Duration.between(last, Instant.now()) < Duration.ofSeconds(10)) {
            messenger.send(sender, "editor.cooldown")
            return@launch
        }
        lastEditor[key] = Instant.now()

        val scope = when (target.lowercase()) {
            "all", "*" -> Scope.All
            "server" -> Scope.Server
            else -> Scope.Plugin(k.collector.pluginFolders().firstOrNull { it.equals(target, ignoreCase = true) } ?: target)
        }
        messenger.send(sender, "editor.opening", tag("scope", scope.wire))
        val opened = try {
            withContext(Dispatchers.IO) {
                k.editor.open(scope, k.settings.sessionTtl.seconds.toInt(), k.settings.redaction, k.settings.reloadCommands, k.serverInfo, sender.name)
            }
        } catch (e: KaizenException) {
            if (e.key == "editor.nothing-found") messenger.send(sender, e.key, tag("scope", scope.wire))
            else messenger.send(sender, "editor.failed", tag("reason", e.message ?: e.key))
            return@launch
        } catch (e: ApiException) {
            messenger.send(sender, "editor.failed", tag("reason", e.message ?: "network error"))
            return@launch
        }
        val minutes = ((Duration.between(Instant.now(), opened.expiresAt).seconds + 59) / 60).coerceAtLeast(1)
        messenger.sendFor(sender, "editor.ready", arg("link", opened.link), tag("minutes", minutes))
        messenger.send(sender, "editor.details", tag("files", opened.fileCount), tag("secrets", opened.secretCount))
        val notable = opened.skipped
        if (notable.isNotEmpty()) {
            val list = notable.take(15).joinToString(if (sender is ConsoleCommandSender) ", " else "\n") { "${it.path} (${it.reason.description})" } +
                if (notable.size > 15) " …" else ""
            messenger.sendFor(sender, "editor.skipped", tag("count", notable.size), tag("list", list))
        }
        if (sender is ConsoleCommandSender) {
            k.logger.info("The editor link above contains the session key and is also in the server log; it expires in $minutes minutes.")
        }
    }

    private fun apply(sender: CommandSender, code: String) = launch(sender) {
        messenger.send(sender, "apply.fetching")
        val prepared = try {
            withContext(Dispatchers.IO) { k.applier.prepare(code, k.settings.redaction) }
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            messenger.send(sender, "apply.failed", tag("reason", describe(e)))
            return@launch
        }
        val token = k.confirmations.put(senderKey(sender), prepared)
        val files = prepared.plan.files
        messenger.send(
            sender,
            "apply.header",
            tag("files", files.size),
            tag("added", files.sumOf { it.stat.added }),
            tag("removed", files.sumOf { it.stat.removed }),
        )
        for (file in files) {
            messenger.send(sender, "apply.file", tag("path", file.path), tag("added", file.stat.added), tag("removed", file.stat.removed))
            file.removedSecrets.forEach { messenger.send(sender, "apply.removed-secret", tag("key", it)) }
        }
        messenger.sendFor(sender, "apply.buttons", arg("token", token))
    }

    private fun confirm(sender: CommandSender, token: String) = launch(sender) {
        val prepared = k.confirmations.take<PreparedApply>(senderKey(sender), token)
        if (prepared == null) {
            messenger.send(sender, "apply.no-pending")
            return@launch
        }
        messenger.send(sender, "apply.writing")
        val manifest = try {
            writeLock.withLock { withContext(Dispatchers.IO) { k.applier.commit(prepared, sender.name) } }
        } catch (e: ApplyFailedException) {
            k.logger.log(Level.WARNING, "Apply failed: ${e.message}", e.cause)
            if (e.rolledBack) messenger.send(sender, "apply.rolled-back", tag("reason", e.cause?.message ?: ""), tag("backup", e.backupId ?: "-"))
            else messenger.send(sender, "apply.not-restored", tag("reason", e.cause?.message ?: ""), tag("files", e.notRestored.joinToString()), tag("backup", e.backupId ?: "-"))
            return@launch
        } catch (e: KaizenException) {
            messenger.send(sender, "apply.failed", tag("reason", e.message ?: e.key))
            return@launch
        }
        messenger.send(sender, "apply.done", tag("files", manifest.files.size), arg("backup", manifest.id))
        k.logger.info("${sender.name} applied editor changes to ${manifest.files.size} file(s): ${manifest.files.joinToString { it.path }} (backup ${manifest.id})")
        reloadReminders(sender, prepared.plan.plugins, prepared.plan.touchesServerFiles)
    }

    /** Tells the admin what needs reloading. Kaizen never reloads other plugins by itself. */
    fun reloadReminders(sender: CommandSender, plugins: List<String>, serverFiles: Boolean) {
        if (plugins.isNotEmpty()) {
            messenger.send(sender, "apply.reload-header")
            for (plugin in plugins) {
                val command = k.settings.reloadCommands.entries.firstOrNull { it.key.equals(plugin, ignoreCase = true) }?.value
                when {
                    command == null || plugin == "Kaizen" -> messenger.send(sender, "apply.reload-manual", tag("plugin", plugin))
                    else -> messenger.sendFor(sender, "apply.reload-button", tag("plugin", plugin), arg("command", command))
                }
            }
        }
        if (serverFiles) messenger.send(sender, "apply.restart-server")
    }

    private fun cancel(sender: CommandSender, token: String) {
        val prepared = k.confirmations.take<PreparedApply>(senderKey(sender), token)
        messenger.send(sender, if (prepared == null) "apply.no-pending" else "apply.cancelled")
    }

    private fun reload(sender: CommandSender) = launch(sender) {
        try {
            k.load()
            messenger.send(sender, "reload.done")
        } catch (e: ConfigException) {
            e.errors.forEach { k.logger.warning("  • $it") }
            messenger.send(sender, "reload.failed", tag("count", e.errors.size))
        }
    }

    // ---------------------------------------------------------------------------------------------

    /**
     * Runs a command body as a coroutine on the main thread. Network and disk work switch to IO
     * inside. Errors are reported to the sender and logged.
     */
    fun launch(sender: CommandSender, block: suspend CoroutineScope.() -> Unit) {
        val key = senderKey(sender)
        if (!busy.add(key)) {
            messenger.send(sender, "command.busy")
            return
        }
        k.scope.launch(k.main) {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                k.logger.log(Level.SEVERE, "Error while running a Kaizen command", e)
                messenger.send(sender, "command.error")
            } finally {
                busy.remove(key)
            }
        }
    }

    private fun describe(e: Exception): String = when (e) {
        is KaizenException, is ApiException -> e.message ?: "unknown error"
        is ProtocolException -> when (e.reason) {
            Reason.AUTH -> "the changes failed verification (wrong key or tampered data)"
            else -> e.message ?: e.reason.wire
        }
        else -> e.message ?: e.javaClass.simpleName
    }

    private fun registerExceptionHandlers() {
        val controller = manager.exceptionController()
        controller.registerHandler(InvalidSyntaxException::class.java) { ctx ->
            messenger.send(ctx.context().sender(), "command.invalid-syntax", tag("syntax", "/" + ctx.exception().correctSyntax()))
        }
        controller.registerHandler(NoPermissionException::class.java) { ctx ->
            messenger.send(ctx.context().sender(), "command.no-permission")
        }
        controller.registerHandler(ArgumentParseException::class.java) { ctx ->
            messenger.send(ctx.context().sender(), "command.invalid-syntax", tag("syntax", ctx.exception().cause.message ?: "?"))
        }
        controller.registerHandler(CommandExecutionException::class.java) { ctx ->
            k.logger.log(Level.SEVERE, "Error while running a Kaizen command", ctx.exception().cause ?: ctx.exception())
            messenger.send(ctx.context().sender(), "command.error")
        }
    }

    companion object {
        fun senderKey(sender: CommandSender): String = (sender as? Player)?.uniqueId?.toString() ?: "console:${sender.name}"
    }
}
