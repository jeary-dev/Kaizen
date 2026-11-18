package dev.jeary.kaizen.core.apply

import dev.jeary.kaizen.core.crypto.Digests
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant

/** One file to replace: [before] is what must be on disk now, [after] is what gets written. */
class FileChange(val path: String, val target: Path, val before: ByteArray, val after: ByteArray)

class ApplyFailedException(
    message: String,
    /** True if every file that was already written got its original back. */
    val rolledBack: Boolean,
    val notRestored: List<String>,
    val backupId: String?,
    cause: Throwable?,
) : Exception(message, cause)

/**
 * All-or-nothing apply:
 *
 * 1. Check that every target still holds exactly [FileChange.before].
 * 2. Back every original up to `backups/<id>/`.
 * 3. Write each file atomically (temp file, fsync, rename).
 * 4. If any write fails, put every file already written back, then report what happened.
 */
class ApplyTransaction(
    private val backups: BackupStore,
    private val writer: (Path, ByteArray) -> Unit = { path, bytes -> AtomicFiles.write(path, bytes) },
) {
    fun execute(
        changes: List<FileChange>,
        kind: BackupManifest.Kind,
        actor: String,
        now: Instant,
        sid: String? = null,
        undoOf: String? = null,
    ): BackupManifest {
        require(changes.isNotEmpty()) { "nothing to apply" }
        require(changes.map { it.target }.toSet().size == changes.size) { "a file appears twice" }

        for (change in changes) {
            val current = try {
                Files.readAllBytes(change.target)
            } catch (e: IOException) {
                throw ApplyFailedException("could not read ${change.path}: ${e.message}", true, emptyList(), null, e)
            }
            if (!current.contentEquals(change.before)) {
                throw ApplyFailedException("${change.path} changed on disk; nothing was written", true, emptyList(), null, null)
            }
        }

        val manifest = try {
            backups.create(kind, actor, changes, now, sid, undoOf)
        } catch (e: IOException) {
            throw ApplyFailedException("could not create the backup, so nothing was written: ${e.message}", true, emptyList(), null, e)
        }

        val attempted = mutableListOf<FileChange>()
        try {
            for (change in changes) {
                attempted += change
                writer(change.target, change.after)
            }
        } catch (e: Exception) {
            val notRestored = rollback(attempted)
            runCatching { backups.markRolledBack(manifest) }
            val failed = attempted.last().path
            throw ApplyFailedException(
                if (notRestored.isEmpty()) "writing $failed failed, so every file was restored: ${e.message}"
                else "writing $failed failed and ${notRestored.size} file(s) could not be restored; originals are in backups/${manifest.id}",
                rolledBack = notRestored.isEmpty(),
                notRestored = notRestored,
                backupId = manifest.id,
                cause = e,
            )
        }
        return manifest
    }

    /** Restores every attempted file whose content is no longer the original. Returns failures. */
    private fun rollback(attempted: List<FileChange>): List<String> = attempted.reversed().mapNotNull { change ->
        try {
            val now = if (Files.exists(change.target)) Files.readAllBytes(change.target) else null
            if (now == null || !Digests.sha256(now).contentEquals(Digests.sha256(change.before))) {
                AtomicFiles.write(change.target, change.before)
            }
            null
        } catch (_: Exception) {
            change.path
        }
    }
}
