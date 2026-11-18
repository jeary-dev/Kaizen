package dev.jeary.kaizen.core.service

import dev.jeary.kaizen.core.apply.ApplyPlan
import dev.jeary.kaizen.core.apply.ApplyPlanner
import dev.jeary.kaizen.core.apply.ApplyTransaction
import dev.jeary.kaizen.core.apply.BackupManifest
import dev.jeary.kaizen.core.crypto.Digests
import dev.jeary.kaizen.core.crypto.OwnerSecret
import dev.jeary.kaizen.core.crypto.SessionKeys
import dev.jeary.kaizen.core.encoding.Base64Url
import dev.jeary.kaizen.core.files.ConfigCollector
import dev.jeary.kaizen.core.files.PathGuard
import dev.jeary.kaizen.core.files.Scope
import dev.jeary.kaizen.core.files.Skipped
import dev.jeary.kaizen.core.http.KaizenApi
import dev.jeary.kaizen.core.protocol.ApplyCode
import dev.jeary.kaizen.core.protocol.EnvelopeCodec
import dev.jeary.kaizen.core.protocol.Kind
import dev.jeary.kaizen.core.protocol.PayloadCodec
import dev.jeary.kaizen.core.protocol.Placeholders
import dev.jeary.kaizen.core.protocol.ServerInfo
import dev.jeary.kaizen.core.protocol.UploadFile
import dev.jeary.kaizen.core.protocol.UploadPayload
import dev.jeary.kaizen.core.redaction.RedactionRules
import dev.jeary.kaizen.core.redaction.Redactor
import dev.jeary.kaizen.core.session.SessionRecord
import dev.jeary.kaizen.core.session.SessionStore
import java.time.Clock
import java.time.Instant
import java.time.temporal.ChronoUnit

/** Something the admin did wrong or can fix, with a message fit to show them directly. */
class KaizenException(val key: String, message: String) : Exception(message)

class OpenedEditor(
    val link: String,
    val sid: String,
    val expiresAt: Instant,
    val fileCount: Int,
    val secretCount: Int,
    val skipped: List<Skipped>,
)

/** `/kaizen editor`: collect, redact, encrypt, upload, remember. */
class EditorService(
    private val collector: ConfigCollector,
    private val api: KaizenApi,
    private val sessions: SessionStore,
    private val owner: OwnerSecret,
    private val webUrl: String,
    private val clock: Clock = Clock.systemUTC(),
) {
    suspend fun open(
        scope: Scope,
        ttlSeconds: Int,
        rules: RedactionRules,
        reloadHints: Map<String, String>,
        server: ServerInfo,
        openedBy: String,
    ): OpenedEditor {
        val collected = collector.collect(scope)
        if (collected.files.isEmpty()) {
            throw KaizenException("editor.nothing-found", "no editable config files were found for ${scope.wire}")
        }

        // Ask the editor server what it allows before sealing anything; also a reachability check.
        val info = api.info()
        if (1 !in info.protocols) {
            throw KaizenException("editor.incompatible", "the editor server does not speak protocol v1; update Kaizen or the web app")
        }
        val ttl = ttlSeconds.coerceIn(info.ttl.min, info.ttl.max)

        // A placeholder tag that no file already contains.
        var tag = Placeholders.newTag()
        while (collected.files.any { Redactor.collides(it.text, tag) }) tag = Placeholders.newTag()

        val keys = SessionKeys.generate()
        val now = clock.instant().truncatedTo(ChronoUnit.SECONDS)
        val expiresAt = now.plusSeconds(ttl.toLong())
        var secretCount = 0
        val files = collected.files.map { file ->
            val redacted = Redactor.redact(file.text, file.lang, rules, tag)
            secretCount += redacted.secrets.size
            UploadFile(
                path = file.path,
                plugin = file.plugin,
                lang = file.lang,
                sha256 = Digests.sha256Hex(file.bytes),
                content = redacted.content,
                secrets = redacted.secrets,
            )
        }
        val payload = UploadPayload(
            sid = keys.sid,
            createdAt = now.toString(),
            expiresAt = expiresAt.toString(),
            server = server,
            scope = scope.wire,
            files = files,
            reloadHints = reloadHints.filterKeys { name -> files.any { it.plugin == name } },
        )
        val plaintext = PayloadCodec.encodeUpload(payload)
        val envelope = EnvelopeCodec.seal(keys, Kind.UPLOAD, 0, plaintext)
        val encodedSize = envelope.encode().length
        if (encodedSize > info.limits.uploadBytes) {
            throw KaizenException(
                "editor.too-large",
                "these files are too large to upload together (${encodedSize / 1024} KiB, the limit is " +
                    "${info.limits.uploadBytes / 1024} KiB); open a single plugin instead",
            )
        }

        val created = api.createSession(envelope, owner.hashFor(keys.sid), keys.editHash, ttl)
        sessions.save(
            SessionRecord(
                sid = keys.sid,
                key = keys.fragmentKey,
                tag = tag,
                scope = scope.wire,
                createdAt = now.toString(),
                expiresAt = created.expiresAt,
                uploadSha256 = Digests.sha256Hex(plaintext),
                files = files.associate { it.path to it.sha256 },
                openedBy = openedBy,
            ),
        )
        return OpenedEditor(
            link = "${webUrl.trimEnd('/')}/e/${keys.sid}#k=${keys.fragmentKey}",
            sid = keys.sid,
            expiresAt = Instant.parse(created.expiresAt),
            fileCount = files.size,
            secretCount = secretCount,
            skipped = collected.skipped,
        )
    }
}

class PreparedApply(val record: SessionRecord, val plan: ApplyPlan)

/** `/kaizen apply`: claim, decrypt, verify, then (after confirmation) write. */
class ApplyService(
    private val api: KaizenApi,
    private val sessions: SessionStore,
    private val owner: OwnerSecret,
    private val guard: PathGuard,
    private val transaction: ApplyTransaction,
    private val clock: Clock = Clock.systemUTC(),
) {
    suspend fun prepare(input: String, rules: RedactionRules): PreparedApply {
        val code = ApplyCode.normalize(input)
            ?: throw KaizenException("apply.bad-code", "that is not an apply code; it looks like K7M2QX9P")
        val claimed = api.claim(code, owner.bearer)
        val record = sessions.load(claimed.sid)
            ?: throw KaizenException("apply.unknown-session", "this server has no record of that editor session")
        when {
            record.status == SessionRecord.Status.APPLIED ->
                throw KaizenException("apply.already-applied", "these changes were already applied")
            record.status != SessionRecord.Status.OPEN || record.expired(clock.instant()) ->
                throw KaizenException("apply.expired", "that editor session has expired; open a new one with /kaizen editor")
        }
        val key = record.key?.let(Base64Url::decodeOrNull)
            ?: throw KaizenException("apply.unknown-session", "this server no longer has the key for that session")
        val keys = SessionKeys(key, record.sid)
        val plaintext = EnvelopeCodec.open(keys, Kind.CHANGES, claimed.envelope)
        val changes = PayloadCodec.decodeChanges(plaintext, record.sid)
        return PreparedApply(record, ApplyPlanner.plan(record, changes, guard, rules))
    }

    /** Writes the plan. Call only after the admin confirmed, and off the main thread. */
    suspend fun commit(prepared: PreparedApply, actor: String): BackupManifest {
        // The session may have expired while the admin was reading the summary.
        val fresh = sessions.load(prepared.record.sid)
        if (fresh == null || fresh.status != SessionRecord.Status.OPEN) {
            throw KaizenException("apply.already-applied", "these changes were already applied")
        }
        val manifest = transaction.execute(
            prepared.plan.files.map { it.change },
            BackupManifest.Kind.APPLY,
            actor,
            clock.instant(),
            sid = prepared.record.sid,
        )
        sessions.close(prepared.record.sid, SessionRecord.Status.APPLIED)
        // Best effort: tell the editor the session is finished, so its ciphertext is deleted now
        // instead of at expiry. The files are already written either way.
        try {
            api.markApplied(prepared.record.sid, owner.bearer)
        } catch (_: dev.jeary.kaizen.core.http.ApiException) {
            // The sweep deletes it at expiry anyway.
        }
        return manifest
    }
}
