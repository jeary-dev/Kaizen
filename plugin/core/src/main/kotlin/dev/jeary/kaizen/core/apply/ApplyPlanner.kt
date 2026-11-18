package dev.jeary.kaizen.core.apply

import dev.jeary.kaizen.core.crypto.Digests
import dev.jeary.kaizen.core.files.ConfigCollector
import dev.jeary.kaizen.core.files.PathGuard
import dev.jeary.kaizen.core.protocol.ChangesPayload
import dev.jeary.kaizen.core.protocol.Lang
import dev.jeary.kaizen.core.protocol.ProtocolException
import dev.jeary.kaizen.core.protocol.ProtocolPaths
import dev.jeary.kaizen.core.protocol.Reason
import dev.jeary.kaizen.core.redaction.RedactionRules
import dev.jeary.kaizen.core.redaction.Redactor
import dev.jeary.kaizen.core.session.SessionRecord
import java.io.IOException
import java.nio.file.Files

class PlannedFile(
    val change: FileChange,
    val plugin: String?,
    val stat: DiffStat,
    /** Keys of locked secrets the admin deleted in the editor. */
    val removedSecrets: List<String>,
) {
    val path: String get() = change.path
}

class ApplyPlan(val sid: String, val files: List<PlannedFile>) {
    val plugins: List<String> get() = files.mapNotNull { it.plugin }.distinct().sorted()
    val touchesServerFiles: Boolean get() = files.any { it.plugin == null }
}

/**
 * Turns a decrypted change set into a verified plan (protocol §6). Nothing here writes to disk.
 * Every rule is checked again, whatever the browser or the web server claimed.
 */
object ApplyPlanner {

    fun plan(record: SessionRecord, changes: ChangesPayload, guard: PathGuard, rules: RedactionRules): ApplyPlan {
        if (changes.sid != record.sid) fail(Reason.MISMATCH, "these changes belong to a different session")
        if (changes.uploadSha256 != record.uploadSha256) fail(Reason.MISMATCH, "these changes were made against a different upload")

        val stale = mutableListOf<String>()
        val planned = mutableListOf<PlannedFile>()
        for (file in changes.files) {
            ProtocolPaths.require(file.path)
            val uploadedHash = record.files[file.path]
                ?: fail(Reason.PATH, "${ProtocolPaths.printable(file.path)} was not part of this editor session")
            if (file.baseSha256 != uploadedHash) fail(Reason.MISMATCH, "${file.path} was edited from a different version")

            val target = guard.resolve(file.path)
            val before = try {
                Files.readAllBytes(target)
            } catch (_: IOException) {
                stale += file.path
                continue
            }
            if (Digests.sha256Hex(before) != uploadedHash) {
                stale += file.path
                continue
            }
            val currentText = ConfigCollector.decodeUtf8(before)
                ?: fail(Reason.MISMATCH, "${file.path} is no longer valid UTF-8")

            // Secrets come from the file as it is on disk now (the hash proves it's the uploaded one).
            val redacted = Redactor.redact(currentText, Lang.forPath(file.path), rules, record.tag)
            val restored = Redactor.restore(file.content, record.tag, redacted.originals)
            val after = restored.content.toByteArray(Charsets.UTF_8)
            if (after.contentEquals(before)) continue

            val keysById = redacted.secrets.associate { it.id to it.key }
            planned += PlannedFile(
                change = FileChange(file.path, target, before, after),
                plugin = ConfigCollector.pluginOf(file.path),
                stat = LineDiff.stat(currentText, restored.content),
                removedSecrets = restored.removed.map { keysById[it] ?: it },
            )
        }
        if (stale.isNotEmpty()) {
            fail(
                Reason.MISMATCH,
                "changed on disk since the editor was opened: ${stale.joinToString { ProtocolPaths.printable(it) }}. " +
                    "Open a new editor to edit the current version.",
            )
        }
        if (planned.isEmpty()) fail(Reason.MALFORMED, "the change set doesn't change anything")
        return ApplyPlan(record.sid, planned.sortedBy { it.path })
    }

    private fun fail(reason: Reason, message: String): Nothing = throw ProtocolException(reason, message)
}
