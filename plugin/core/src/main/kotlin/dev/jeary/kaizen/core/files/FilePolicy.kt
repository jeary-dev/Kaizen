package dev.jeary.kaizen.core.files

import dev.jeary.kaizen.core.protocol.ProtocolPaths

/**
 * Which files Kaizen may read and write. Paths are always relative to the server root and use `/`.
 *
 * A file is in scope only if it is one of [serverFiles], or it sits inside a plugin's data folder
 * (`plugins/<Name>/…`). It must also not match [excludes], have an allowlisted extension, and be
 * under [maxFileBytes].
 */
data class FilePolicy(
    val serverFiles: List<String> = DEFAULT_SERVER_FILES,
    val excludes: List<String> = DEFAULT_EXCLUDES,
    val maxFileBytes: Long = 512L * 1024,
    val maxFiles: Int = 2000,
    val maxTotalBytes: Long = 24L * 1024 * 1024,
    val maxDepth: Int = 8,
) {
    private val excludeMatchers = excludes.map(Glob::compile)

    fun isExcluded(relative: String): Boolean = excludeMatchers.any { it.matches(relative) }

    /** True for paths Kaizen may ever touch. This is the format check plus the scope rules, with no I/O. */
    fun inScope(relative: String): Boolean {
        if (!ProtocolPaths.isValid(relative) || isExcluded(relative)) return false
        if (relative in serverFiles) return true
        val segments = relative.split('/')
        return segments.size >= 3 && segments[0] == PLUGINS && segments.size - 2 <= maxDepth
    }

    companion object {
        const val PLUGINS = "plugins"

        /** The server's own config files that Kaizen may edit. */
        val DEFAULT_SERVER_FILES = listOf(
            "server.properties",
            "bukkit.yml",
            "spigot.yml",
            "commands.yml",
            "help.yml",
            "permissions.yml",
            "config/paper-global.yml",
            "config/paper-world-defaults.yml",
            "paper.yml",
            "purpur.yml",
            "pufferfish.yml",
        )

        /**
         * Skipped by default: player data, storage, caches, logs, bundled libraries, and Kaizen's own
         * backups and keys. These are data, not configuration, and they can be large or private.
         */
        val DEFAULT_EXCLUDES = listOf(
            "plugins/.*/**",
            "plugins/*/userdata/**",
            "plugins/*/playerdata/**",
            "plugins/*/players/**",
            "plugins/*/data/**",
            "plugins/*/storage/**",
            "plugins/*/database/**",
            "plugins/*/cache/**",
            "plugins/*/tmp/**",
            "plugins/*/temp/**",
            "plugins/*/logs/**",
            "plugins/*/libs/**",
            "plugins/*/lib/**",
            "plugins/*/libraries/**",
            "plugins/*/backups/**",
            "plugins/*/backup/**",
            "plugins/*/yaml-storage/**",
            "plugins/*/json-storage/**",
            "plugins/*/usercache.json",
            "plugins/Kaizen/**",
        )
    }
}

/**
 * Minimal glob over `/`-separated relative paths: `**` matches anything (including `/`), `*`
 * anything except `/`, and `?` one character except `/`. Matching is case-insensitive, because
 * Windows file systems are.
 */
class Glob private constructor(val pattern: String, private val regex: Regex) {
    fun matches(path: String): Boolean = regex.matches(path)

    override fun toString(): String = pattern

    companion object {
        fun compile(pattern: String): Glob {
            val out = StringBuilder()
            var i = 0
            while (i < pattern.length) {
                val c = pattern[i]
                when {
                    c == '*' && pattern.startsWith("**/", i) -> { out.append("(?:.*/)?"); i += 3; continue }
                    c == '*' && pattern.startsWith("**", i) -> { out.append(".*"); i += 2; continue }
                    c == '*' -> out.append("[^/]*")
                    c == '?' -> out.append("[^/]")
                    else -> out.append(Regex.escape(c.toString()))
                }
                i++
            }
            return Glob(pattern, Regex(out.toString(), RegexOption.IGNORE_CASE))
        }

        /** Returns an error message for a pattern an admin wrote, or null if it is fine. */
        fun validate(pattern: String): String? = when {
            pattern.isBlank() -> "the pattern is empty"
            pattern.startsWith("/") -> "patterns are relative to the server folder; remove the leading /"
            pattern.contains('\\') -> "use / as the separator"
            else -> null
        }
    }
}
