package dev.jeary.kaizen.core.files

import dev.jeary.kaizen.core.protocol.ProtocolException
import dev.jeary.kaizen.core.protocol.Reason
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.junit.jupiter.params.ParameterizedTest
import org.junit.jupiter.params.provider.ValueSource
import org.junit.jupiter.api.assertThrows
import java.io.IOException
import java.nio.file.Files
import java.nio.file.Path

class FileSafetyTest {
    @TempDir
    lateinit var root: Path

    @TempDir
    lateinit var outside: Path

    private lateinit var guard: PathGuard
    private lateinit var collector: ConfigCollector

    private fun write(rel: String, text: String) {
        val p = root.resolve(rel)
        Files.createDirectories(p.parent)
        Files.writeString(p, text)
    }

    private fun symlink(link: Path, target: Path): Boolean = try {
        Files.createSymbolicLink(link, target)
        true
    } catch (_: IOException) {
        false // Windows without Developer Mode can't create symlinks
    } catch (_: UnsupportedOperationException) {
        false
    }

    @BeforeEach
    fun setUp() {
        write("server.properties", "motd=hi\n")
        write("bukkit.yml", "settings: {}\n")
        write("config/paper-global.yml", "a: 1\n")
        write("plugins/Essentials/config.yml", "x: 1\n")
        write("plugins/Essentials/messages/en.yml", "hi: there\n")
        write("plugins/Essentials/userdata/abc.yml", "money: 5\n")
        write("plugins/Essentials/notes.md", "not allowlisted\n")
        write("plugins/LuckPerms/config.yml", "storage-method: h2\n")
        write("plugins/Kaizen/config.yml", "web-url: x\n")
        write("plugins/Kaizen/backups/1/files/server.properties", "x\n")
        write("plugins/.paper-remapped/x.yml", "a: 1\n")
        write("ops.json", "[]\n")
        write("whitelist.json", "[]\n")
        Files.write(root.resolve("plugins/Essentials/binary.yml"), byteArrayOf(0x61, 0xff.toByte(), 0xfe.toByte()))
        write("plugins/Essentials/big.yml", "x".repeat(600 * 1024))
        Files.createDirectories(root.resolve("plugins/Essentials/dir.yml"))
        Files.write(root.resolve("plugins/Essentials/Essentials.jar"), byteArrayOf(1, 2, 3))
        guard = PathGuard(root, FilePolicy())
        collector = ConfigCollector(guard)
    }

    @ParameterizedTest
    @ValueSource(
        strings = [
            "../outside.yml",
            "plugins/../../outside.yml",
            "/etc/passwd.yml",
            "plugins\\Essentials\\config.yml",
            "C:/Windows/win.ini.txt",
            "plugins/Essentials/../../server.properties",
            "plugins/Essentials/userdata/abc.yml",
            "plugins/Kaizen/config.yml",
            "plugins/Essentials/Essentials.jar",
            "ops.json",
            "eula.txt",
            "plugins/config.yml",
            "world/level.dat.yml",
            "plugins/Essentials/dir.yml",
            "plugins/Missing/config.yml",
        ],
    )
    fun `the guard refuses traversal, scope escapes and non-files`(path: String) {
        val e = assertThrows<ProtocolException> { guard.resolve(path) }
        assertEquals(Reason.PATH, e.reason)
    }

    @Test
    fun `the guard accepts real config files`() {
        assertEquals(root.resolve("server.properties"), guard.resolve("server.properties"))
        assertEquals(root.resolve("config/paper-global.yml"), guard.resolve("config/paper-global.yml"))
        assertEquals(root.resolve("plugins/Essentials/messages/en.yml"), guard.resolve("plugins/Essentials/messages/en.yml"))
        // A file that doesn't exist yet in an existing plugin folder is still a valid target path.
        guard.resolve("plugins/Essentials/new.yml")
    }

    @Test
    fun `a symlinked file or folder is refused, even when it points inside the server`() {
        val fileLink = symlink(root.resolve("plugins/Essentials/link.yml"), outside.resolve("target.yml").also { Files.writeString(it, "x: 1") })
        assumeTrue(fileLink, "symlinks are not available on this system")
        symlink(root.resolve("plugins/Linked"), outside)
        Files.writeString(outside.resolve("config.yml"), "evil: true")
        symlink(root.resolve("plugins/Essentials/inner"), root.resolve("plugins/LuckPerms"))

        for (p in listOf("plugins/Essentials/link.yml", "plugins/Linked/config.yml", "plugins/Essentials/inner/config.yml")) {
            assertThrows<ProtocolException>(p) { guard.resolve(p) }
        }
        val all = collector.collect(Scope.All)
        assertFalse(all.files.any { it.path.contains("link") || it.path.contains("Linked") || it.path.contains("inner") })
        assertTrue(all.skipped.any { it.path == "plugins/Essentials/link.yml" && it.reason == SkipReason.SYMLINK })
    }

    @Test
    fun `collect all picks configs and skips data, binaries, big files and Kaizen itself`() {
        val result = collector.collect(Scope.All)
        assertEquals(
            listOf(
                "bukkit.yml",
                "config/paper-global.yml",
                "plugins/Essentials/config.yml",
                "plugins/Essentials/messages/en.yml",
                "plugins/LuckPerms/config.yml",
                "server.properties",
            ),
            result.files.map { it.path },
        )
        val skipped = result.skipped.associate { it.path to it.reason }
        assertEquals(SkipReason.NOT_TEXT, skipped["plugins/Essentials/binary.yml"])
        assertEquals(SkipReason.TOO_LARGE, skipped["plugins/Essentials/big.yml"])
        assertEquals("Essentials", result.files.first { it.path.startsWith("plugins/Essentials") }.plugin)
        assertEquals(null, result.files.first { it.path == "server.properties" }.plugin)
    }

    @Test
    fun `scopes narrow the collection`() {
        assertEquals(
            listOf("plugins/Essentials/config.yml", "plugins/Essentials/messages/en.yml"),
            collector.collect(Scope.Plugin("Essentials")).files.map { it.path },
        )
        assertEquals(
            listOf("bukkit.yml", "config/paper-global.yml", "server.properties"),
            collector.collect(Scope.Server).files.map { it.path },
        )
        assertTrue(collector.collect(Scope.Plugin("../Essentials")).files.isEmpty())
        assertTrue(collector.collect(Scope.Plugin("Kaizen")).files.isEmpty())
        assertEquals(listOf("Essentials", "LuckPerms"), collector.pluginFolders())
    }

    @Test
    fun `file count and total size limits are enforced`() {
        val tight = ConfigCollector(PathGuard(root, FilePolicy(maxFiles = 2)))
        val result = tight.collect(Scope.All)
        assertEquals(2, result.files.size)
        assertTrue(result.skipped.count { it.reason == SkipReason.LIMIT_REACHED } >= 4)
    }

    @Test
    fun `globs`() {
        val g = Glob.compile("plugins/*/userdata/**")
        assertTrue(g.matches("plugins/Essentials/userdata/a.yml"))
        assertTrue(g.matches("plugins/essentials/USERDATA/x/y.yml"))
        assertFalse(g.matches("plugins/Essentials/config.yml"))
        assertFalse(g.matches("plugins/a/b/userdata/x.yml"))
        assertTrue(Glob.compile("**/secrets.yml").matches("plugins/x/secrets.yml"))
        assertTrue(Glob.compile("**/secrets.yml").matches("secrets.yml"))
        assertEquals(null, Glob.validate("plugins/*/x/**"))
        assertTrue(Glob.validate("/abs") != null)
    }
}
