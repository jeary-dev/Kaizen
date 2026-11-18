package dev.jeary.kaizen.platform

import dev.jeary.kaizen.config.Messages
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import net.kyori.adventure.platform.bukkit.BukkitAudiences
import net.kyori.adventure.text.Component
import net.kyori.adventure.text.minimessage.MiniMessage
import net.kyori.adventure.text.minimessage.tag.resolver.Placeholder
import net.kyori.adventure.text.minimessage.tag.resolver.TagResolver
import org.bukkit.Bukkit
import org.bukkit.command.CommandSender
import org.bukkit.command.ConsoleCommandSender
import org.bukkit.plugin.IllegalPluginAccessException
import org.bukkit.plugin.Plugin
import java.util.logging.Level
import kotlin.coroutines.CoroutineContext

/** Runs coroutines on the server's main thread. Skips the hop when already there. */
class MainThreadDispatcher(private val plugin: Plugin) : CoroutineDispatcher() {
    override fun isDispatchNeeded(context: CoroutineContext): Boolean = !Bukkit.isPrimaryThread()

    override fun dispatch(context: CoroutineContext, block: Runnable) {
        try {
            Bukkit.getScheduler().runTask(plugin, block)
        } catch (_: IllegalPluginAccessException) {
            // Disabling: the scheduler refuses new tasks; run inline so the coroutine can finish.
            block.run()
        }
    }

    override fun toString(): String = "Bukkit.Main"
}

/** The plugin's coroutine scope. One failing task never cancels the others. */
class PluginScope(plugin: Plugin) : CoroutineScope {
    private val handler = CoroutineExceptionHandler { _, error ->
        plugin.logger.log(Level.SEVERE, "Unhandled error in a background task", error)
    }
    override val coroutineContext: CoroutineContext = SupervisorJob() + handler

    fun shutdown() = cancel("Kaizen is disabling")
}

/**
 * All text goes through here: MiniMessage templates from messages.yml, delivered with
 * adventure-platform so the same code works on Spigot and on Paper.
 */
class Messenger(plugin: Plugin, @Volatile var messages: Messages) {
    private val mm = MiniMessage.miniMessage()
    private val audiences = BukkitAudiences.create(plugin)

    fun component(key: String, vararg tags: TagResolver): Component? {
        val raw = messages.raw(key)
        if (raw.isBlank()) return null
        return mm.deserialize(raw, TagResolver.resolver(Placeholder.parsed("prefix", messages.prefix), *tags))
    }

    fun send(sender: CommandSender, key: String, vararg tags: TagResolver) {
        component(key, *tags)?.let { audiences.sender(sender).sendMessage(it) }
    }

    /** The console can't click, so some messages have a `-console` variant. */
    fun sendFor(sender: CommandSender, key: String, vararg tags: TagResolver) {
        val consoleKey = "$key-console"
        val useConsole = sender is ConsoleCommandSender && !messages.raw(consoleKey).startsWith("<red>Missing message")
        send(sender, if (useConsole) consoleKey else key, *tags)
    }

    fun close() = audiences.close()

    companion object {
        /** Plain text, shown as-is. */
        fun tag(name: String, value: Any): TagResolver = Placeholder.unparsed(name, value.toString())

        /**
         * A value used inside tag arguments, such as a URL in `click:open_url` or a command in
         * `click:run_command`. Those need a parsed placeholder, so we strip every character that
         * could close the argument or open a tag.
         */
        fun arg(name: String, value: String): TagResolver =
            Placeholder.parsed(name, value.filterNot { it == '\'' || it == '"' || it == '<' || it == '>' || it == '\\' || it.isISOControl() })
    }
}
