package dev.jeary.kaizen.core.apply

import dev.jeary.kaizen.core.crypto.Digests
import dev.jeary.kaizen.core.crypto.Randomness
import dev.jeary.kaizen.core.protocol.ProtocolPaths
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

@Serializable
data class BackupFile(val path: String, val before: String, val after: String)

@Serializable
data class BackupManifest(
    val id: String,
    val createdAt: String,
    val kind: Kind,
    val actor: String,
    val files: List<BackupFile>,
    val sid: String? = null,
    /** For an undo: the backup that was restored. */
    val undoOf: String? = null,
    val status: Status = Status.APPLIED,
) {
    @Serializable
    enum class Kind { APPLY, UNDO }

    @Serializable
    enum class Status { APPLIED, ROLLED_BACK }
}

/**
 * `plugins/Kaizen/backups/<id>/` holds `manifest.json` plus a copy of every original file under
 * `files/<relative path>`. Ids sort chronologically: `20261118-131502-k3f9`.
 */
class BackupStore(val dir: Path) {
    private val json = Json { ignoreUnknownKeys = true; prettyPrint = true; encodeDefaults = true }

    fun create(
        kind: BackupManifest.Kind,
        actor: String,
        changes: List<FileChange>,
        now: Instant,
        sid: String? = null,
        undoOf: String? = null,
    ): BackupManifest {
        val id = "${STAMP.format(now)}-${Randomness.chars("abcdefghijkmnpqrstuvwxyz23456789", 4)}"
        val root = dir.resolve(id)
        Files.createDirectories(root.resolve(FILES))
        for (change in changes) {
            val copy = root.resolve(FILES).resolve(change.path).normalize()
            require(copy.startsWith(root.resolve(FILES))) { "backup path escapes the backup folder" }
            Files.createDirectories(copy.parent)
            AtomicFiles.write(copy, change.before)
        }
        val manifest = BackupManifest(
            id = id,
            createdAt = now.toString(),
            kind = kind,
            actor = actor,
            files = changes.map { BackupFile(it.path, Digests.sha256Hex(it.before), Digests.sha256Hex(it.after)) },
            sid = sid,
            undoOf = undoOf,
        )
        writeManifest(manifest)
        return manifest
    }

    fun markRolledBack(manifest: BackupManifest) = writeManifest(manifest.copy(status = BackupManifest.Status.ROLLED_BACK))

    /** The bytes of [path] as they were before backup [id] was applied. */
    fun original(id: String, path: String): ByteArray {
        require(isValidId(id) && ProtocolPaths.isValid(path)) { "invalid backup reference" }
        val root = dir.resolve(id).resolve(FILES)
        val file = root.resolve(path).normalize()
        require(file.startsWith(root)) { "backup path escapes the backup folder" }
        return Files.readAllBytes(file)
    }

    fun get(id: String): BackupManifest? {
        if (!isValidId(id)) return null
        val file = dir.resolve(id).resolve(MANIFEST)
        if (!Files.isRegularFile(file)) return null
        return try {
            json.decodeFromString(BackupManifest.serializer(), Files.readString(file))
        } catch (_: SerializationException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    /** All backups, newest first. */
    fun list(): List<BackupManifest> {
        if (!Files.isDirectory(dir)) return emptyList()
        return Files.list(dir).use { s -> s.toList() }
            .map { it.fileName.toString() }
            .filter(::isValidId)
            .sortedDescending()
            .mapNotNull(::get)
    }

    /**
     * Retention: keep at most [maxCount] backups, and none older than [maxAge]. The newest backup
     * is always kept, so there is always something to undo.
     */
    fun prune(now: Instant, maxCount: Int, maxAge: Duration): List<String> {
        val all = list()
        val removed = mutableListOf<String>()
        all.forEachIndexed { index, manifest ->
            val tooMany = index >= maxCount
            val tooOld = Instant.parse(manifest.createdAt).plus(maxAge).isBefore(now)
            if (index > 0 && (tooMany || tooOld)) {
                try {
                    deleteTree(dir.resolve(manifest.id))
                    removed += manifest.id
                } catch (_: IOException) {
                    // Leave it for the next prune.
                }
            }
        }
        return removed
    }

    private fun writeManifest(manifest: BackupManifest) {
        AtomicFiles.write(dir.resolve(manifest.id).resolve(MANIFEST), json.encodeToString(BackupManifest.serializer(), manifest).toByteArray())
    }

    private fun deleteTree(root: Path) {
        Files.walk(root).use { s -> s.sorted(Comparator.reverseOrder()).toList() }.forEach(Files::deleteIfExists)
    }

    companion object {
        private const val MANIFEST = "manifest.json"
        private const val FILES = "files"
        private val STAMP: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").withZone(ZoneOffset.UTC)
        private val ID = Regex("^\\d{8}-\\d{6}-[a-z0-9]{4}$")

        fun isValidId(id: String): Boolean = ID.matches(id)
    }
}
