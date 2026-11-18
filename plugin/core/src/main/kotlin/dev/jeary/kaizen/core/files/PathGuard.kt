package dev.jeary.kaizen.core.files

import dev.jeary.kaizen.core.protocol.ProtocolPaths
import dev.jeary.kaizen.core.protocol.Reason
import dev.jeary.kaizen.core.protocol.ProtocolException
import java.io.IOException
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.attribute.BasicFileAttributes

/**
 * Turns a relative path from the wire into a real file under the server root. It refuses
 * anything outside the root, anything outside the policy's scope, and any path that passes
 * through a symlink or a Windows junction.
 *
 * Every check runs again at write time. The guard is cheap and the file system can change.
 */
class PathGuard(root: Path, val policy: FilePolicy) {
    val root: Path = root.toAbsolutePath().normalize()
    private val realRoot: Path by lazy { this.root.toRealPath() }

    /**
     * Resolves [relative] to a path that is safe to read or write. The file itself need not
     * exist, but its parent folder must.
     */
    fun resolve(relative: String): Path {
        if (!policy.inScope(relative)) reject(relative, "is not an editable config file")
        val target = root.resolve(relative).normalize()
        if (!target.startsWith(root) || target == root) reject(relative, "escapes the server folder")

        // Walk every component from the root down. None of them may be a link.
        var current = root
        for (segment in root.relativize(target)) {
            current = current.resolve(segment)
            if (Files.isSymbolicLink(current)) reject(relative, "passes through a symbolic link")
        }

        // Junctions (Windows) and bind mounts are not reported as symlinks, so we also compare
        // the real path of the parent with where it should be.
        val parent = target.parent ?: reject(relative, "has no parent folder")
        val realParent = try {
            parent.toRealPath()
        } catch (e: IOException) {
            reject(relative, "its folder does not exist", e)
        }
        val expectedParent = realRoot.resolve(root.relativize(parent).toString()).normalize()
        if (realParent != expectedParent) reject(relative, "resolves outside its expected folder")

        if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
            val attrs = Files.readAttributes(target, BasicFileAttributes::class.java, LinkOption.NOFOLLOW_LINKS)
            if (!attrs.isRegularFile) reject(relative, "is not a regular file")
        }
        return target
    }

    /** The relative, `/`-separated form of an absolute path under the root. */
    fun relativize(path: Path): String = root.relativize(path.toAbsolutePath().normalize()).joinToString("/")

    private fun reject(relative: String, why: String, cause: Throwable? = null): Nothing =
        throw ProtocolException(Reason.PATH, "${ProtocolPaths.printable(relative)} $why", cause)
}
