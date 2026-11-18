package dev.jeary.kaizen.config

import net.kyori.adventure.text.minimessage.MiniMessage
import net.kyori.adventure.text.minimessage.ParsingException
import org.bukkit.configuration.ConfigurationSection
import org.bukkit.configuration.file.YamlConfiguration
import java.io.InputStreamReader

/**
 * messages.yml, flattened to `section.key -> MiniMessage`. Keys missing from the admin's file fall
 * back to the bundled defaults, so an old messages.yml keeps working after an update.
 */
class Messages(private val entries: Map<String, String>, private val defaults: Map<String, String>) {
    val prefix: String get() = raw("prefix")

    fun raw(key: String): String = entries[key] ?: defaults[key] ?: "<red>Missing message: $key"

    companion object {
        const val FILE = "messages.yml"

        fun defaults(): Map<String, String> {
            val stream = Messages::class.java.classLoader.getResourceAsStream(FILE) ?: return emptyMap()
            return InputStreamReader(stream, Charsets.UTF_8).use { flatten(YamlConfiguration.loadConfiguration(it)) }
        }

        fun load(section: ConfigurationSection, defaults: Map<String, String>): Messages {
            val entries = flatten(section)
            val errors = mutableListOf<ConfigError>()
            val mm = MiniMessage.miniMessage()
            for ((key, value) in entries) {
                if (key !in defaults) {
                    errors += ConfigError(FILE, key, "unknown message key (typo? see the bundled messages.yml)")
                    continue
                }
                try {
                    mm.deserialize(value.replace("<prefix>", ""))
                } catch (e: ParsingException) {
                    errors += ConfigError(FILE, key, "invalid MiniMessage: ${e.message?.lineSequence()?.firstOrNull()}")
                }
            }
            if (errors.isNotEmpty()) throw ConfigException(errors)
            return Messages(entries, defaults)
        }

        private fun flatten(section: ConfigurationSection): Map<String, String> =
            section.getKeys(true).mapNotNull { key ->
                val value = section.get(key)
                if (value is String) key to value else null
            }.toMap()
    }
}
