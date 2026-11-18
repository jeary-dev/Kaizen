package dev.jeary.kaizen.core.protocol

/** Format rules for paths that cross the wire (protocol §7). Filesystem policy lives in `files`. */
object ProtocolPaths {
    const val MAX_LENGTH = 512

    val ALLOWED_EXTENSIONS: Set<String> = setOf("yml", "yaml", "json", "properties", "toml", "conf", "txt")

    fun isValid(path: String): Boolean {
        if (path.isEmpty() || path.length > MAX_LENGTH) return false
        if (path.startsWith("/")) return false
        if (path.any { it == '\\' || it == ':' || it.isISOControl() }) return false
        val segments = path.split('/')
        if (segments.any { it.isEmpty() || it == "." || it == ".." }) return false
        return extensionOf(segments.last()) in ALLOWED_EXTENSIONS
    }

    fun extensionOf(name: String): String = name.substringAfterLast('.', "").lowercase()

    fun require(path: String) {
        if (!isValid(path)) fail(Reason.PATH, "invalid path: ${printable(path)}")
    }

    /** For error messages: never echo control characters back into a console. */
    fun printable(path: String): String =
        path.take(120).map { if (it.isISOControl()) '?' else it }.joinToString("")
}

/** Apply codes (protocol §9). */
object ApplyCode {
    const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    const val LENGTH = 8
    private val PATTERN = Regex("^[0-9A-HJKMNP-TV-Z]{8}$")

    /** Normalizes user input, or returns null if it can't be a valid code. */
    fun normalize(input: String): String? {
        val cleaned = buildString {
            for (c in input) {
                when (val u = c.uppercaseChar()) {
                    ' ', '-' -> Unit
                    'O' -> append('0')
                    'I', 'L' -> append('1')
                    else -> append(u)
                }
            }
        }
        return cleaned.takeIf(PATTERN::matches)
    }

    /** The friendlier display form, `K7M2 QX9P`. */
    fun display(code: String): String = code.chunked(4).joinToString(" ")
}

/** Secret placeholders (protocol §8). */
object Placeholders {
    private const val TAG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
    const val TAG_LENGTH = 4

    val ID_PATTERN = Regex("^KAIZEN_SECRET_[1-9][0-9]*_[a-z0-9]{4}$")

    /** Matches any placeholder-shaped token inside file content. */
    val ANY = Regex("KAIZEN_SECRET_[1-9][0-9]*_[a-z0-9]{4}")

    fun id(index: Int, tag: String): String = "KAIZEN_SECRET_${index}_$tag"

    fun newTag(): String = dev.jeary.kaizen.core.crypto.Randomness.chars(TAG_ALPHABET, TAG_LENGTH)

    fun isValidTag(tag: String): Boolean = tag.length == TAG_LENGTH && tag.all { it in TAG_ALPHABET }
}
