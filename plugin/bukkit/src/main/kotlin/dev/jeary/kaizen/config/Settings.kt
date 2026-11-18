package dev.jeary.kaizen.config

import dev.jeary.kaizen.core.files.FilePolicy
import dev.jeary.kaizen.core.files.Glob
import dev.jeary.kaizen.core.protocol.ProtocolPaths
import dev.jeary.kaizen.core.redaction.RedactionRules
import org.bukkit.configuration.ConfigurationSection
import java.net.URI
import java.time.Duration

/** One problem in a config file: the file, the path inside it, and what's wrong. */
data class ConfigError(val file: String, val path: String, val message: String) {
    override fun toString() = "$file → $path: $message"
}

class ConfigException(val errors: List<ConfigError>) : Exception(errors.joinToString("\n"))

/**
 * A path-aware reader that collects every problem instead of stopping at the first, so an admin
 * sees them all at once.
 */
class ConfigReader(private val file: String, private val root: ConfigurationSection) {
    val errors = mutableListOf<ConfigError>()

    fun error(path: String, message: String) {
        errors += ConfigError(file, path, message)
    }

    private fun raw(path: String): Any? = root.get(path)

    fun string(path: String, default: String): String = when (val v = raw(path)) {
        null -> default
        is String -> v
        is Number, is Boolean -> v.toString()
        else -> default.also { error(path, "expected text, got ${describe(v)}") }
    }

    fun bool(path: String, default: Boolean): Boolean = when (val v = raw(path)) {
        null -> default
        is Boolean -> v
        else -> default.also { error(path, "expected true or false, got ${describe(v)}") }
    }

    fun int(path: String, default: Int, range: IntRange): Int {
        val v = raw(path) ?: return default
        val n = (v as? Number)?.toDouble() ?: (v as? String)?.trim()?.toDoubleOrNull()
        if (n == null || n % 1.0 != 0.0) return default.also { error(path, "expected a whole number from ${range.first} to ${range.last}, got ${describe(v)}") }
        if (n.toInt() !in range) return default.also { error(path, "must be from ${range.first} to ${range.last}, got ${n.toInt()}") }
        return n.toInt()
    }

    fun duration(path: String, default: Duration, min: Duration, max: Duration): Duration {
        val v = raw(path) ?: return default
        val parsed = parseDuration(v.toString())
            ?: return default.also { error(path, "expected a duration like 30m, 1h or 7d, got ${describe(v)}") }
        if (parsed < min || parsed > max) {
            return default.also { error(path, "must be between ${format(min)} and ${format(max)}, got ${format(parsed)}") }
        }
        return parsed
    }

    fun stringList(path: String): List<String> = when (val v = raw(path)) {
        null -> emptyList()
        is List<*> -> v.mapIndexedNotNull { i, item ->
            when (item) {
                is String -> item
                is Number, is Boolean -> item.toString()
                else -> null.also { error("$path[$i]", "expected text, got ${describe(item)}") }
            }
        }
        else -> emptyList<String>().also { error(path, "expected a list, got ${describe(v)}") }
    }

    fun stringMap(path: String): Map<String, String> {
        val v = raw(path) ?: return emptyMap()
        val section = v as? ConfigurationSection
            ?: return emptyMap<String, String>().also { error(path, "expected a section of name: value pairs") }
        return section.getKeys(false).associateWith { key ->
            when (val item = section.get(key)) {
                is String -> item
                null -> ""
                else -> item.toString()
            }
        }
    }

    companion object {
        private val DURATION_PART = Regex("(\\d+)\\s*([smhd])", RegexOption.IGNORE_CASE)

        fun parseDuration(text: String): Duration? {
            val t = text.trim()
            t.toLongOrNull()?.let { return Duration.ofSeconds(it) }
            if (t.isEmpty() || DURATION_PART.replace(t, "").isNotBlank()) return null
            return DURATION_PART.findAll(t).fold(Duration.ZERO) { acc, m ->
                val n = m.groupValues[1].toLong()
                acc + when (m.groupValues[2].lowercase()) {
                    "s" -> Duration.ofSeconds(n)
                    "m" -> Duration.ofMinutes(n)
                    "h" -> Duration.ofHours(n)
                    else -> Duration.ofDays(n)
                }
            }
        }

        fun format(d: Duration): String = when {
            d.toDays() > 0 && d == Duration.ofDays(d.toDays()) -> "${d.toDays()}d"
            d.toHours() > 0 && d == Duration.ofHours(d.toHours()) -> "${d.toHours()}h"
            d.toMinutes() > 0 && d == Duration.ofMinutes(d.toMinutes()) -> "${d.toMinutes()}m"
            else -> "${d.seconds}s"
        }

        private fun describe(v: Any?): String = when (v) {
            null -> "nothing"
            is String -> "\"$v\""
            is ConfigurationSection -> "a section"
            is List<*> -> "a list"
            else -> v.toString()
        }
    }
}

/** Everything in config.yml, validated. */
data class Settings(
    val webUrl: String,
    val sessionTtl: Duration,
    val filePolicy: FilePolicy,
    val redaction: RedactionRules,
    val backupKeep: Int,
    val backupMaxAge: Duration,
    val reloadCommands: Map<String, String>,
    val httpTimeout: Duration,
) {
    companion object {
        const val FILE = "config.yml"

        fun load(root: ConfigurationSection): Settings {
            val r = ConfigReader(FILE, root)

            val webUrl = r.string("web-url", "https://edit.jeary.dev").trim().trimEnd('/')
            validateWebUrl(webUrl)?.let { r.error("web-url", it) }

            val ttl = r.duration("session.expire-after", Duration.ofHours(1), Duration.ofMinutes(5), Duration.ofDays(7))

            val serverFiles = r.stringList("files.server-files").ifEmpty { FilePolicy.DEFAULT_SERVER_FILES }
            serverFiles.forEachIndexed { i, p ->
                if (!ProtocolPaths.isValid(p) || p.startsWith("plugins/")) {
                    r.error("files.server-files[$i]", "\"$p\" is not a valid server config path (relative, with an allowed extension, not in plugins/)")
                }
            }
            val extraExcludes = r.stringList("files.exclude")
            extraExcludes.forEachIndexed { i, p -> Glob.validate(p)?.let { r.error("files.exclude[$i]", it) } }
            val disableDefaults = r.bool("files.disable-default-excludes", false)
            // Kaizen's own folder (keys, sessions, backups) is never editable, whatever the config says.
            val excludes = (if (disableDefaults) listOf("plugins/Kaizen/**") else FilePolicy.DEFAULT_EXCLUDES) + extraExcludes
            val policy = FilePolicy(
                serverFiles = serverFiles.filter(ProtocolPaths::isValid),
                excludes = excludes.filter { Glob.validate(it) == null },
                maxFileBytes = r.int("files.max-file-size-kb", 512, 1..4096) * 1024L,
                maxFiles = r.int("files.max-files", 2000, 1..10_000),
            )

            val rules = RedactionRules.compile(
                RedactionRules.DEFAULT_KEY_PATTERNS.map { it.pattern } + r.stringList("redaction.extra-key-patterns"),
                RedactionRules.DEFAULT_VALUE_PATTERNS.map { it.pattern } + r.stringList("redaction.extra-value-patterns"),
            ) { pattern, problem -> r.error("redaction", "invalid pattern \"$pattern\": $problem") }

            val reload = r.stringMap("reload-commands").mapValues { it.value.trim().removePrefix("/") }
            reload.forEach { (plugin, cmd) ->
                if (cmd.isBlank()) r.error("reload-commands.$plugin", "the command is empty")
                if (cmd.any { it == '\n' || it == '\r' }) r.error("reload-commands.$plugin", "the command must be on one line")
            }

            val settings = Settings(
                webUrl = webUrl,
                sessionTtl = ttl,
                filePolicy = policy,
                redaction = rules,
                backupKeep = r.int("backups.keep", 50, 1..10_000),
                backupMaxAge = r.duration("backups.max-age", Duration.ofDays(30), Duration.ofHours(1), Duration.ofDays(3650)),
                reloadCommands = reload.filterValues { it.isNotBlank() },
                httpTimeout = r.duration("http.timeout", Duration.ofSeconds(15), Duration.ofSeconds(3), Duration.ofMinutes(2)),
            )
            if (r.errors.isNotEmpty()) throw ConfigException(r.errors)
            return settings
        }

        /** https:// only, except http:// to the local machine for testing a self-hosted copy. */
        fun validateWebUrl(url: String): String? {
            val uri = runCatching { URI(url) }.getOrNull() ?: return "\"$url\" is not a valid URL"
            val host = uri.host ?: return "\"$url\" has no host name"
            if (uri.userInfo != null || uri.rawQuery != null || uri.rawFragment != null) return "use just the address, like https://edit.jeary.dev"
            return when (uri.scheme?.lowercase()) {
                "https" -> null
                "http" -> if (host == "localhost" || host == "127.0.0.1" || host == "[::1]") null
                else "must start with https:// (plain http:// is only allowed for localhost)"
                else -> "must start with https://"
            }
        }
    }
}
