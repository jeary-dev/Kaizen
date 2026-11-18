package dev.jeary.kaizen.core.redaction

import dev.jeary.kaizen.core.protocol.Lang
import dev.jeary.kaizen.core.protocol.Placeholders
import dev.jeary.kaizen.core.protocol.ProtocolException
import dev.jeary.kaizen.core.protocol.Reason
import dev.jeary.kaizen.core.protocol.SecretRef

/**
 * What counts as a secret. Key patterns match the *last* key segment, with case ignored
 * (`database.password` is tested as `password`). Value patterns match any value, whatever its key.
 */
class RedactionRules(
    val keyPatterns: List<Regex> = DEFAULT_KEY_PATTERNS,
    val valuePatterns: List<Regex> = DEFAULT_VALUE_PATTERNS,
) {
    fun isSecretKey(key: String?): Boolean {
        if (key.isNullOrEmpty()) return false
        val last = key.substringAfterLast('.').trim().trim('"', '\'')
        return keyPatterns.any { it.matches(last) }
    }

    fun isSecretValue(value: String): Boolean = valuePatterns.any { it.containsMatchIn(value) }

    companion object {
        private val I = setOf(RegexOption.IGNORE_CASE)

        val DEFAULT_KEY_PATTERNS: List<Regex> = listOf(
            ".*(password|passwd|passphrase|secret|token|webhook|credential).*",
            ".*(api|access|auth|private|secret|client|license|encryption|signing)[-_. ]?key.*",
            "(pass|pwd|pw|apikey|bearer|cookie|salt|dsn|connection[-_]?string)",
        ).map { Regex(it, I) }

        val DEFAULT_VALUE_PATTERNS: List<Regex> = listOf(
            // JDBC URLs with a password parameter, or user:password@ in any URL
            "jdbc:[^\\s\"']*[?&;](password|pwd)=",
            "[a-z][a-z0-9+.-]*://[^/\\s:@\"']+:[^@\\s/\"']+@",
            // Discord / Slack webhooks
            "https://(?:[a-z]+\\.)?discord(?:app)?\\.com/api/webhooks/\\d+/",
            "https://hooks\\.slack\\.com/services/",
            // Private keys
            "-----BEGIN [A-Z ]*PRIVATE KEY-----",
        ).map { Regex(it, I) }

        /** Builds rules from admin-written patterns, reporting each invalid one. */
        fun compile(keys: List<String>, values: List<String>, onError: (String, String) -> Unit): RedactionRules {
            fun build(list: List<String>) = list.mapNotNull { pattern ->
                try {
                    Regex(pattern, I)
                } catch (e: IllegalArgumentException) {
                    onError(pattern, e.message?.lineSequence()?.firstOrNull() ?: "invalid regular expression")
                    null
                }
            }
            return RedactionRules(build(keys), build(values))
        }
    }
}

/** A secret value's location: [start, end) in UTF-16 chars, excluding any quotes. */
data class SecretSpan(val start: Int, val end: Int, val key: String)

class Redacted(
    val content: String,
    val secrets: List<SecretRef>,
    /** Placeholder id to the exact original text. Kept in memory only, never persisted or sent. */
    val originals: Map<String, String>,
)

class Restored(val content: String, val removed: List<String>)

/**
 * Replaces secret values with placeholders, and puts them back on apply (protocol §8).
 *
 * Redaction is deterministic. For the same content, rules and tag it produces the same
 * placeholders, so on apply the plugin re-runs it on the file currently on disk to get the real
 * values back, and never has to store secrets anywhere.
 */
object Redactor {

    fun redact(content: String, lang: Lang, rules: RedactionRules, tag: String): Redacted {
        require(Placeholders.isValidTag(tag)) { "invalid placeholder tag" }
        val spans = normalize(Scanners.scan(content, lang, rules))
        if (spans.isEmpty()) return Redacted(content, emptyList(), emptyMap())

        val out = StringBuilder(content.length)
        val secrets = mutableListOf<SecretRef>()
        val originals = LinkedHashMap<String, String>()
        var cursor = 0
        spans.forEachIndexed { i, span ->
            val id = Placeholders.id(i + 1, tag)
            out.append(content, cursor, span.start).append(id)
            originals[id] = content.substring(span.start, span.end)
            secrets += SecretRef(id, span.key, lineOf(content, span.start))
            cursor = span.end
        }
        out.append(content, cursor, content.length)
        return Redacted(out.toString(), secrets, originals)
    }

    /**
     * Puts the real values back into [content]. Only placeholders with this session's [tag] count.
     * Each may appear at most once, and only ids that exist in [originals] are allowed.
     */
    fun restore(content: String, tag: String, originals: Map<String, String>): Restored {
        val pattern = placeholderPattern(tag)
        val found = pattern.findAll(content).map { it.value }.toList()
        val duplicates = found.groupingBy { it }.eachCount().filterValues { it > 1 }.keys
        if (duplicates.isNotEmpty()) {
            throw ProtocolException(Reason.PLACEHOLDER, "a locked secret appears more than once: ${duplicates.first()}")
        }
        val unknown = found.firstOrNull { it !in originals }
        if (unknown != null) throw ProtocolException(Reason.PLACEHOLDER, "unknown secret placeholder: $unknown")
        // The lambda form of replace inserts its result literally, so `$` and `\` in secrets are safe.
        val restored = pattern.replace(content) { m -> originals.getValue(m.value) }
        return Restored(restored, originals.keys.filter { it !in found })
    }

    /** True if [content] already contains something shaped like a placeholder with [tag]. */
    fun collides(content: String, tag: String): Boolean = placeholderPattern(tag).containsMatchIn(content)

    private fun placeholderPattern(tag: String) =
        Regex("(?<![A-Za-z0-9_])KAIZEN_SECRET_[1-9][0-9]*_${Regex.escape(tag)}(?![A-Za-z0-9_])")

    /** Sorted, non-empty, non-overlapping spans. If two overlap, the earlier one wins. */
    private fun normalize(spans: List<SecretSpan>): List<SecretSpan> {
        val result = mutableListOf<SecretSpan>()
        for (span in spans.filter { it.end > it.start }.sortedWith(compareBy({ it.start }, { -it.end }))) {
            if (result.isEmpty() || span.start >= result.last().end) result += span
        }
        return result
    }

    private fun lineOf(content: String, index: Int): Int {
        var line = 1
        for (i in 0 until index) if (content[i] == '\n') line++
        return line
    }
}
