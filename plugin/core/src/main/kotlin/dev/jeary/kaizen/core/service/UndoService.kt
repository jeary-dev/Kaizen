package dev.jeary.kaizen.core.service

import dev.jeary.kaizen.core.apply.ApplyTransaction
import dev.jeary.kaizen.core.apply.BackupManifest
import dev.jeary.kaizen.core.apply.BackupStore
import dev.jeary.kaizen.core.apply.FileChange
import dev.jeary.kaizen.core.crypto.Digests
import dev.jeary.kaizen.core.files.ConfigCollector
import dev.jeary.kaizen.core.files.PathGuard
import dev.jeary.kaizen.core.protocol.ProtocolException
import java.io.IOException
import java.nio.file.Files
import java.time.Clock

/** What `/kaizen undo` will do, shown to the admin before they confirm. */
class UndoPlan(
    val target: BackupManifest,
    val changes: List<FileChange>,
    /** Files edited after [target] was made; undoing also drops those later edits. */
    val changedSince: List<String>,
    /** Files that already match the backup and are left alone. */
    val unchanged: List<String>,
) {
    val plugins: List<String> = changes.mapNotNull { ConfigCollector.pluginOf(it.path) }.distinct()
    val touchesServerFiles: Boolean = changes.any { ConfigCollector.pluginOf(it.path) == null }
}

/**
 * Restores the files of one backup to how they were before it. An undo goes through the same
 * all-or-nothing transaction as an apply, and is backed up too, so it can be undone in turn.
 */
class UndoService(
    private val backups: BackupStore,
    private val guard: PathGuard,
    private val transaction: ApplyTransaction,
    private val clock: Clock = Clock.systemUTC(),
) {
    /** The newest change first. Rolled-back entries are included so the history is complete. */
    fun history(): List<BackupManifest> = backups.list()

    /** Plans undoing [id], or the most recent change when [id] is null. Nothing is written. */
    fun plan(id: String?): UndoPlan {
        val target = if (id == null) {
            backups.list().firstOrNull { it.status == BackupManifest.Status.APPLIED }
                ?: throw KaizenException("undo.nothing", "there is nothing to undo yet")
        } else {
            (if (BackupStore.isValidId(id)) backups.get(id) else null)
                ?: throw KaizenException("undo.not-found", "there is no backup called $id")
        }
        if (target.status == BackupManifest.Status.ROLLED_BACK) {
            throw KaizenException("undo.rolled-back", "that apply was already rolled back")
        }

        val changes = mutableListOf<FileChange>()
        val changedSince = mutableListOf<String>()
        val unchanged = mutableListOf<String>()
        for (file in target.files) {
            val path = try {
                guard.resolve(file.path)
            } catch (e: ProtocolException) {
                throw KaizenException("undo.failed", "${file.path} can't be restored: ${e.message}")
            }
            val original = try {
                backups.original(target.id, file.path)
            } catch (e: IOException) {
                throw KaizenException("undo.failed", "the backup of ${file.path} is missing (${e.message})")
            }
            if (Digests.sha256Hex(original) != file.before) {
                throw KaizenException("undo.failed", "the backup of ${file.path} was modified, so it can't be trusted")
            }
            val current = try {
                Files.readAllBytes(path)
            } catch (e: IOException) {
                throw KaizenException("undo.failed", "could not read ${file.path}: ${e.message}")
            }
            when {
                current.contentEquals(original) -> unchanged += file.path
                else -> {
                    if (Digests.sha256Hex(current) != file.after) changedSince += file.path
                    changes += FileChange(file.path, path, before = current, after = original)
                }
            }
        }
        if (changes.isEmpty()) throw KaizenException("undo.identical", "the files already match how they were before ${target.id}")
        return UndoPlan(target, changes, changedSince, unchanged)
    }

    /**
     * Writes the plan. The transaction checks every file again first, so an edit made between
     * the prompt and the confirmation makes it refuse instead of overwriting.
     */
    fun commit(plan: UndoPlan, actor: String): BackupManifest =
        transaction.execute(plan.changes, BackupManifest.Kind.UNDO, actor, clock.instant(), undoOf = plan.target.id)
}
