package dev.jeary.kaizen.core.service

import dev.jeary.kaizen.core.apply.ApplyFailedException
import dev.jeary.kaizen.core.apply.ApplyTransaction
import dev.jeary.kaizen.core.apply.BackupManifest
import dev.jeary.kaizen.core.apply.BackupStore
import dev.jeary.kaizen.core.apply.FileChange
import dev.jeary.kaizen.core.files.FilePolicy
import dev.jeary.kaizen.core.files.PathGuard
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

class UndoTest {
    @TempDir
    lateinit var root: Path

    private lateinit var backups: BackupStore
    private lateinit var undo: UndoService
    private var clockNow = Instant.parse("2026-11-18T13:00:00Z")

    private fun read(rel: String) = Files.readString(root.resolve(rel))
    private fun write(rel: String, text: String) {
        val p = root.resolve(rel)
        Files.createDirectories(p.parent)
        Files.writeString(p, text)
    }

    /** Applies [edits] the way /kaizen apply would, one second after the previous change. */
    private fun apply(vararg edits: Pair<String, String>): BackupManifest {
        clockNow = clockNow.plusSeconds(1)
        val changes = edits.map { (rel, after) ->
            val target = root.resolve(rel)
            FileChange(rel, target, Files.readAllBytes(target), after.toByteArray())
        }
        return ApplyTransaction(backups).execute(changes, BackupManifest.Kind.APPLY, "Alice", clockNow, sid = "s")
    }

    @BeforeEach
    fun setUp() {
        backups = BackupStore(root.resolve("plugins/Kaizen/backups"))
        val clock = object : Clock() {
            override fun getZone() = ZoneOffset.UTC
            override fun withZone(zone: java.time.ZoneId?) = this
            override fun instant(): Instant = clockNow.plusMillis(500)
        }
        undo = UndoService(backups, PathGuard(root, FilePolicy()), ApplyTransaction(backups), clock)
        write("plugins/Shop/config.yml", "rows: 6\r\nname: \"Sakura\"\r\n")
        write("server.properties", "motd=hi\n")
    }

    @Test
    fun `undoes the newest change by default, restoring exact bytes, and the undo can be undone`() {
        apply("plugins/Shop/config.yml" to "rows: 5\r\nname: \"Sakura\"\r\n")
        val second = apply("plugins/Shop/config.yml" to "rows: 4\r\nname: \"Sakura\"\r\n", "server.properties" to "motd=hello\n")

        val plan = undo.plan(null)
        assertEquals(second.id, plan.target.id)
        assertEquals(listOf("Shop"), plan.plugins)
        assertTrue(plan.touchesServerFiles)
        assertEquals(emptyList<String>(), plan.changedSince)

        val undone = undo.commit(plan, "Bob")
        assertEquals(BackupManifest.Kind.UNDO, undone.kind)
        assertEquals(second.id, undone.undoOf)
        assertEquals("rows: 5\r\nname: \"Sakura\"\r\n", read("plugins/Shop/config.yml"))
        assertEquals("motd=hi\n", read("server.properties"))

        // "Undo" again targets the undo itself, which redoes the change.
        val redo = undo.plan(null)
        assertEquals(undone.id, redo.target.id)
        undo.commit(redo, "Bob")
        assertEquals("rows: 4\r\nname: \"Sakura\"\r\n", read("plugins/Shop/config.yml"))
        assertEquals(listOf(BackupManifest.Kind.UNDO, BackupManifest.Kind.UNDO, BackupManifest.Kind.APPLY, BackupManifest.Kind.APPLY), undo.history().map { it.kind })
    }

    @Test
    fun `undoes an older change by id and warns about files changed since`() {
        val first = apply("plugins/Shop/config.yml" to "rows: 5\n", "server.properties" to "motd=a\n")
        apply("plugins/Shop/config.yml" to "rows: 3\n")

        val plan = undo.plan(first.id)
        assertEquals(listOf("plugins/Shop/config.yml"), plan.changedSince)
        undo.commit(plan, "Alice")
        assertEquals("rows: 6\r\nname: \"Sakura\"\r\n", read("plugins/Shop/config.yml"))
        assertEquals("motd=hi\n", read("server.properties"))
    }

    @Test
    fun `leaves files that already match and refuses when nothing would change`() {
        val change = apply("plugins/Shop/config.yml" to "rows: 5\n", "server.properties" to "motd=a\n")
        write("server.properties", "motd=hi\n") // someone reverted it by hand

        val plan = undo.plan(change.id)
        assertEquals(listOf("server.properties"), plan.unchanged)
        assertEquals(listOf("plugins/Shop/config.yml"), plan.changes.map { it.path })
        assertFalse(plan.touchesServerFiles)

        write("plugins/Shop/config.yml", "rows: 6\r\nname: \"Sakura\"\r\n")
        assertEquals("undo.identical", assertThrows<KaizenException> { undo.plan(change.id) }.key)
    }

    @Test
    fun `refuses a backup that was tampered with`() {
        val change = apply("plugins/Shop/config.yml" to "rows: 5\n")
        Files.writeString(backups.dir.resolve(change.id).resolve("files/plugins/Shop/config.yml"), "evil: true\n")
        val e = assertThrows<KaizenException> { undo.plan(change.id) }
        assertEquals("undo.failed", e.key)
        assertTrue(e.message?.contains("modified") == true)
        assertEquals("rows: 5\n", read("plugins/Shop/config.yml"))
    }

    @Test
    fun `refuses to overwrite an edit made between the prompt and the confirmation`() {
        apply("plugins/Shop/config.yml" to "rows: 5\n")
        val plan = undo.plan(null)
        write("plugins/Shop/config.yml", "rows: 9\n")
        val e = assertThrows<ApplyFailedException> { undo.commit(plan, "Alice") }
        assertTrue(e.rolledBack)
        assertEquals("rows: 9\n", read("plugins/Shop/config.yml"))
    }

    @Test
    fun `explains missing, malformed and rolled-back ids`() {
        assertEquals("undo.nothing", assertThrows<KaizenException> { undo.plan(null) }.key)
        assertEquals("undo.not-found", assertThrows<KaizenException> { undo.plan("20260101-000000-abcd") }.key)
        assertEquals("undo.not-found", assertThrows<KaizenException> { undo.plan("../../etc") }.key)

        val failing = ApplyTransaction(backups) { _, _ -> throw IOException("disk full") }
        val target = root.resolve("plugins/Shop/config.yml")
        val e = assertThrows<ApplyFailedException> {
            failing.execute(listOf(FileChange("plugins/Shop/config.yml", target, Files.readAllBytes(target), "x".toByteArray())), BackupManifest.Kind.APPLY, "Alice", clockNow)
        }
        assertEquals("undo.rolled-back", assertThrows<KaizenException> { undo.plan(e.backupId) }.key)
        // A rolled-back entry is skipped when picking the default.
        assertEquals("undo.nothing", assertThrows<KaizenException> { undo.plan(null) }.key)
    }
}
