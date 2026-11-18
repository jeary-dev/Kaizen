package dev.jeary.kaizen.core.apply

import dev.jeary.kaizen.core.crypto.Digests
import dev.jeary.kaizen.core.files.FilePolicy
import dev.jeary.kaizen.core.files.PathGuard
import dev.jeary.kaizen.core.protocol.ChangedFile
import dev.jeary.kaizen.core.protocol.ChangesPayload
import dev.jeary.kaizen.core.protocol.Lang
import dev.jeary.kaizen.core.protocol.ProtocolException
import dev.jeary.kaizen.core.protocol.Reason
import dev.jeary.kaizen.core.redaction.RedactionRules
import dev.jeary.kaizen.core.redaction.Redactor
import dev.jeary.kaizen.core.session.SessionRecord
import dev.jeary.kaizen.core.session.SessionStore
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.time.Instant

class ApplyTest {
    @TempDir
    lateinit var root: Path

    private lateinit var backups: BackupStore
    private val now = Instant.parse("2026-11-18T13:00:00Z")

    private fun file(rel: String, text: String): Path =
        root.resolve(rel).also { Files.createDirectories(it.parent); Files.writeString(it, text) }

    @BeforeEach
    fun setUp() {
        backups = BackupStore(root.resolve("plugins/Kaizen/backups"))
    }

    private fun change(rel: String, after: String): FileChange {
        val target = root.resolve(rel)
        return FileChange(rel, target, Files.readAllBytes(target), after.toByteArray())
    }

    @Nested
    inner class Transaction {
        @Test
        fun `writes every file and backs up the originals`() {
            file("plugins/A/config.yml", "a: 1\n")
            file("plugins/B/config.yml", "b: 1\n")
            val manifest = ApplyTransaction(backups).execute(
                listOf(change("plugins/A/config.yml", "a: 2\n"), change("plugins/B/config.yml", "b: 2\n")),
                BackupManifest.Kind.APPLY,
                "console",
                now,
                sid = "s",
            )
            assertEquals("a: 2\n", Files.readString(root.resolve("plugins/A/config.yml")))
            assertEquals("b: 2\n", Files.readString(root.resolve("plugins/B/config.yml")))
            assertArrayEquals("a: 1\n".toByteArray(), backups.original(manifest.id, "plugins/A/config.yml"))
            assertEquals(listOf(manifest), backups.list())
            assertEquals(Digests.sha256Hex("b: 2\n".toByteArray()), manifest.files[1].after)
            // No temp files left behind.
            Files.walk(root).use { s -> assertFalse(s.anyMatch { it.fileName.toString().endsWith(".tmp") }) }
        }

        @Test
        fun `a failure on the third file rolls the first two back`() {
            val names = listOf("plugins/A/a.yml", "plugins/A/b.yml", "plugins/A/c.yml")
            names.forEach { file(it, "original $it\n") }
            var writes = 0
            val failing = ApplyTransaction(backups) { path, bytes ->
                if (++writes == 3) throw IOException("disk full")
                AtomicFiles.write(path, bytes)
            }
            val e = assertThrows<ApplyFailedException> {
                failing.execute(names.map { change(it, "changed\n") }, BackupManifest.Kind.APPLY, "console", now)
            }
            assertTrue(e.rolledBack)
            assertTrue(e.notRestored.isEmpty())
            names.forEach { assertEquals("original $it\n", Files.readString(root.resolve(it))) }
            assertEquals(BackupManifest.Status.ROLLED_BACK, backups.list().single().status)
        }

        @Test
        fun `nothing is written if a file changed on disk in the meantime`() {
            file("plugins/A/a.yml", "one\n")
            file("plugins/A/b.yml", "two\n")
            val changes = listOf(change("plugins/A/a.yml", "1\n"), change("plugins/A/b.yml", "2\n"))
            Files.writeString(root.resolve("plugins/A/b.yml"), "edited by someone else\n")
            assertThrows<ApplyFailedException> { ApplyTransaction(backups).execute(changes, BackupManifest.Kind.APPLY, "c", now) }
            assertEquals("one\n", Files.readString(root.resolve("plugins/A/a.yml")))
            assertTrue(backups.list().isEmpty())
        }

        @Test
        fun `retention keeps the newest and drops by count and age`() {
            file("plugins/A/a.yml", "0\n")
            val tx = ApplyTransaction(backups)
            val ids = (1..5).map { i ->
                tx.execute(listOf(change("plugins/A/a.yml", "$i\n")), BackupManifest.Kind.APPLY, "c", now.plus(Duration.ofDays(i.toLong()))).id
            }
            val removed = backups.prune(now.plus(Duration.ofDays(5)), maxCount = 3, maxAge = Duration.ofDays(30))
            assertEquals(ids.take(2).sorted(), removed.sorted())
            assertEquals(ids.drop(2).reversed(), backups.list().map { it.id })
            // Age-based: everything is old, but the newest survives.
            backups.prune(now.plus(Duration.ofDays(400)), maxCount = 100, maxAge = Duration.ofDays(30))
            assertEquals(listOf(ids.last()), backups.list().map { it.id })
        }
    }

    @Nested
    inner class Planner {
        private val rules = RedactionRules()
        private val tag = "ab12"
        private lateinit var guard: PathGuard
        private val original = "host: localhost\npassword: hunter2\nport: 1\n"

        @BeforeEach
        fun setUp() {
            file("plugins/Shop/config.yml", original)
            file("server.properties", "motd=hi\n")
            guard = PathGuard(root, FilePolicy())
        }

        private fun record(files: Map<String, String> = mapOf(
            "plugins/Shop/config.yml" to Digests.sha256Hex(original.toByteArray()),
            "server.properties" to Digests.sha256Hex("motd=hi\n".toByteArray()),
        )) = SessionRecord("AAAAAAAAAAAAAAAAAAAAAA", "k", tag, "all", now.toString(), now.plusSeconds(3600).toString(), "u".repeat(64), files, "console")

        private fun redacted(text: String) = Redactor.redact(text, Lang.YAML, rules, tag).content

        private fun changes(vararg files: ChangedFile) =
            ChangesPayload(sid = "AAAAAAAAAAAAAAAAAAAAAA", uploadSha256 = "u".repeat(64), createdAt = now.toString(), files = files.toList())

        private fun edit(path: String, content: String, base: String = record().files.getValue(path)) = ChangedFile(path, base, content)

        @Test
        fun `restores secrets from disk and counts changed lines`() {
            val content = redacted(original).replace("port: 1", "port: 2\nnew: x")
            val plan = ApplyPlanner.plan(record(), changes(edit("plugins/Shop/config.yml", content)), guard, rules)
            val file = plan.files.single()
            assertEquals("host: localhost\npassword: hunter2\nport: 2\nnew: x\n", String(file.change.after))
            assertEquals(DiffStat(added = 2, removed = 1), file.stat)
            assertEquals(listOf("Shop"), plan.plugins)
            assertFalse(plan.touchesServerFiles)
        }

        @Test
        fun `reports secrets the admin deleted`() {
            val content = "host: localhost\nport: 1\n"
            val plan = ApplyPlanner.plan(record(), changes(edit("plugins/Shop/config.yml", content)), guard, rules)
            assertEquals(listOf("password"), plan.files.single().removedSecrets)
        }

        @Test
        fun `refuses paths that were not uploaded, even valid ones`() {
            file("plugins/Shop/other.yml", "x: 1\n")
            val e = assertThrows<ProtocolException> {
                ApplyPlanner.plan(record(), changes(ChangedFile("plugins/Shop/other.yml", "0".repeat(64), "x: 2\n")), guard, rules)
            }
            assertEquals(Reason.PATH, e.reason)
        }

        @Test
        fun `refuses traversal even if the record was tampered with`() {
            val evil = "plugins/Shop/../../outside.yml"
            val e = assertThrows<ProtocolException> {
                ApplyPlanner.plan(record(mapOf(evil to "0".repeat(64))), changes(ChangedFile(evil, "0".repeat(64), "x")), guard, rules)
            }
            assertEquals(Reason.PATH, e.reason)
        }

        @Test
        fun `refuses when the file changed on disk since upload`() {
            Files.writeString(root.resolve("plugins/Shop/config.yml"), "edited: elsewhere\n")
            val e = assertThrows<ProtocolException> {
                ApplyPlanner.plan(record(), changes(edit("plugins/Shop/config.yml", "x: 1\n")), guard, rules)
            }
            assertEquals(Reason.MISMATCH, e.reason)
            assertTrue(e.message?.contains("changed on disk") == true)
        }

        @Test
        fun `refuses a wrong base hash, a wrong upload hash and unknown placeholders`() {
            assertEquals(Reason.MISMATCH, assertThrows<ProtocolException> {
                ApplyPlanner.plan(record(), changes(edit("plugins/Shop/config.yml", "x", base = "f".repeat(64))), guard, rules)
            }.reason)
            assertEquals(Reason.MISMATCH, assertThrows<ProtocolException> {
                ApplyPlanner.plan(record(), changes(edit("plugins/Shop/config.yml", "x")).copy(uploadSha256 = "f".repeat(64)), guard, rules)
            }.reason)
            assertEquals(Reason.PLACEHOLDER, assertThrows<ProtocolException> {
                ApplyPlanner.plan(record(), changes(edit("plugins/Shop/config.yml", "a: KAIZEN_SECRET_7_ab12\n")), guard, rules)
            }.reason)
        }

        @Test
        fun `a change set that changes nothing is refused`() {
            val e = assertThrows<ProtocolException> {
                ApplyPlanner.plan(record(), changes(edit("plugins/Shop/config.yml", redacted(original))), guard, rules)
            }
            assertEquals(Reason.MALFORMED, e.reason)
        }
    }

    @Test
    fun `line diff counts`() {
        assertEquals(DiffStat(0, 0), LineDiff.stat("a\nb\n", "a\nb\n"))
        assertEquals(DiffStat(1, 0), LineDiff.stat("a\nb\n", "a\nx\nb\n"))
        assertEquals(DiffStat(1, 1), LineDiff.stat("a\nb\nc\n", "a\nB\nc\n"))
        assertEquals(DiffStat(0, 0), LineDiff.stat("a\r\nb\r\n", "a\nb\n"))
        assertEquals(DiffStat(3, 0), LineDiff.stat("", "a\nb\nc"))
        val big = (1..5000).joinToString("\n") { "line $it" }
        assertEquals(DiffStat(1, 1), LineDiff.stat(big, big.replace("line 2500\n", "changed\n")))
    }

    @Test
    fun `session store keeps records, closes them and prunes expired ones`(@TempDir dir: Path) {
        val store = SessionStore(dir)
        val record = SessionRecord("BBBBBBBBBBBBBBBBBBBBBB", "key", "ab12", "all", now.toString(), now.plusSeconds(60).toString(), "u", emptyMap(), "console")
        store.save(record)
        assertEquals(record, store.load(record.sid))
        assertNull(store.load("../../etc"))
        store.close(record.sid, SessionRecord.Status.APPLIED)
        val closed = store.load(record.sid)
        assertEquals(SessionRecord.Status.APPLIED, closed?.status)
        assertNull(closed?.key, "the key is forgotten once a session is done")
        assertFalse(record.expired(now.plusSeconds(59)))
        assertTrue(record.expired(now.plusSeconds(60)))
        assertEquals(0, store.prune(now.plusSeconds(120), graceSeconds = 3600))
        assertEquals(1, store.prune(now.plusSeconds(3660), graceSeconds = 3600))
        assertTrue(store.all().isEmpty())
    }
}
