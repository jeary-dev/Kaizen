package dev.jeary.kaizen.core.session

import dev.jeary.kaizen.core.apply.AtomicFiles
import dev.jeary.kaizen.core.crypto.SessionId
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant

/**
 * What the plugin remembers about an editor session it opened. It holds the session key (needed
 * to decrypt the changes) but never a secret value: those are re-read from disk on apply.
 */
@Serializable
data class SessionRecord(
    val sid: String,
    /** base64url session key `K`. Dropped as soon as the session is applied or discarded. */
    val key: String?,
    val tag: String,
    val scope: String,
    val createdAt: String,
    val expiresAt: String,
    val uploadSha256: String,
    /** Path to SHA-256 of the raw bytes uploaded. Only these files can ever be changed. */
    val files: Map<String, String>,
    val openedBy: String,
    val status: Status = Status.OPEN,
) {
    @Serializable
    enum class Status { OPEN, APPLIED, DISCARDED }

    fun expired(now: Instant): Boolean = !now.isBefore(Instant.parse(expiresAt))
}

/**
 * One small JSON file per session in `plugins/Kaizen/data/sessions/`. Files are written atomically
 * and restricted to the owner where the file system supports it.
 */
class SessionStore(private val dir: Path) {
    private val json = Json { ignoreUnknownKeys = true; prettyPrint = true; encodeDefaults = true }

    @Synchronized
    fun save(record: SessionRecord) {
        require(SessionId.isValid(record.sid)) { "invalid session id" }
        Files.createDirectories(dir)
        AtomicFiles.write(fileFor(record.sid), json.encodeToString(SessionRecord.serializer(), record).toByteArray(), private = true)
    }

    @Synchronized
    fun load(sid: String): SessionRecord? {
        if (!SessionId.isValid(sid)) return null
        val file = fileFor(sid)
        if (!Files.isRegularFile(file)) return null
        return try {
            json.decodeFromString(SessionRecord.serializer(), Files.readString(file))
        } catch (_: SerializationException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    @Synchronized
    fun all(): List<SessionRecord> {
        if (!Files.isDirectory(dir)) return emptyList()
        return Files.list(dir).use { s -> s.toList() }
            .filter { it.fileName.toString().endsWith(".json") }
            .mapNotNull { load(it.fileName.toString().removeSuffix(".json")) }
            .sortedBy { it.createdAt }
    }

    /** Marks a session finished and forgets its key, so it can never decrypt anything again. */
    @Synchronized
    fun close(sid: String, status: SessionRecord.Status) {
        val record = load(sid) ?: return
        save(record.copy(key = null, status = status))
    }

    /** Deletes records that expired more than [grace] ago. Returns how many were removed. */
    @Synchronized
    fun prune(now: Instant, graceSeconds: Long = 3600): Int {
        var removed = 0
        for (record in all()) {
            if (!now.isBefore(Instant.parse(record.expiresAt).plusSeconds(graceSeconds))) {
                try {
                    Files.deleteIfExists(fileFor(record.sid))
                    removed++
                } catch (_: IOException) {
                    // Try again on the next prune.
                }
            }
        }
        return removed
    }

    private fun fileFor(sid: String): Path = dir.resolve("$sid.json")
}
