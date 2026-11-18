package dev.jeary.kaizen.core.files

import dev.jeary.kaizen.core.protocol.Lang
import dev.jeary.kaizen.core.protocol.ProtocolException
import dev.jeary.kaizen.core.protocol.ProtocolPaths
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.file.FileVisitResult
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.SimpleFileVisitor
import java.nio.file.attribute.BasicFileAttributes

/** What `/kaizen editor` was asked to open. */
sealed interface Scope {
    val wire: String

    data object All : Scope {
        override val wire = "all"
    }

    data object Server : Scope {
        override val wire = "server"
    }

    data class Plugin(val name: String) : Scope {
        override val wire get() = name
    }
}

class CollectedFile(
    val path: String,
    val plugin: String?,
    val lang: Lang,
    val bytes: ByteArray,
    val text: String,
)

data class Skipped(val path: String, val reason: SkipReason)

enum class SkipReason(val description: String) {
    TOO_LARGE("larger than the size limit"),
    NOT_TEXT("not valid UTF-8 text"),
    SYMLINK("a symbolic link"),
    UNSAFE_PATH("an unsafe path"),
    LIMIT_REACHED("over the file count or total size limit"),
    UNREADABLE("could not be read"),
}

class CollectedFiles(val files: List<CollectedFile>, val skipped: List<Skipped>) {
    val totalBytes: Long get() = files.sumOf { it.bytes.size.toLong() }
}

/**
 * Gathers the config files for a scope. It never follows links, never leaves the server folder,
 * and skips (and reports) anything binary, oversized or excluded.
 */
class ConfigCollector(private val guard: PathGuard) {
    private val policy get() = guard.policy
    private val root get() = guard.root

    /** Plugin folders that contain at least one editable file, for tab completion. */
    fun pluginFolders(): List<String> {
        val plugins = root.resolve(FilePolicy.PLUGINS)
        if (!Files.isDirectory(plugins, LinkOption.NOFOLLOW_LINKS)) return emptyList()
        return Files.list(plugins).use { stream ->
            stream.filter { Files.isDirectory(it, LinkOption.NOFOLLOW_LINKS) }
                .map { it.fileName.toString() }
                .filter { name -> !name.startsWith(".") && policy.inScope("${FilePolicy.PLUGINS}/$name/config.yml") }
                .sorted(String.CASE_INSENSITIVE_ORDER)
                .toList()
        }
    }

    fun collect(scope: Scope): CollectedFiles {
        val candidates = mutableListOf<Path>()
        val skipped = mutableListOf<Skipped>()

        if (scope is Scope.All || scope is Scope.Server) {
            for (rel in policy.serverFiles) {
                val path = root.resolve(rel)
                if (Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) candidates.add(path)
                else if (Files.isSymbolicLink(path)) skipped.add(Skipped(rel, SkipReason.SYMLINK))
            }
        }
        when (scope) {
            is Scope.All -> walk(root.resolve(FilePolicy.PLUGINS), candidates, skipped)
            is Scope.Plugin -> {
                val folder = root.resolve(FilePolicy.PLUGINS).resolve(scope.name).normalize()
                val inside = folder.parent == root.resolve(FilePolicy.PLUGINS).normalize()
                if (inside && Files.isDirectory(folder, LinkOption.NOFOLLOW_LINKS)) walk(folder, candidates, skipped)
            }
            is Scope.Server -> Unit
        }

        val files = mutableListOf<CollectedFile>()
        var total = 0L
        for (path in candidates.sortedBy { guard.relativize(it).lowercase() }) {
            val rel = guard.relativize(path)
            val size = try {
                Files.size(path)
            } catch (_: IOException) {
                skipped += Skipped(rel, SkipReason.UNREADABLE); continue
            }
            when {
                size > policy.maxFileBytes -> { skipped += Skipped(rel, SkipReason.TOO_LARGE); continue }
                files.size >= policy.maxFiles || total + size > policy.maxTotalBytes -> {
                    skipped += Skipped(rel, SkipReason.LIMIT_REACHED); continue
                }
            }
            val safe = try {
                guard.resolve(rel)
            } catch (_: ProtocolException) {
                skipped += Skipped(rel, SkipReason.UNSAFE_PATH); continue
            }
            val bytes = try {
                Files.readAllBytes(safe)
            } catch (_: IOException) {
                skipped += Skipped(rel, SkipReason.UNREADABLE); continue
            }
            if (bytes.size > policy.maxFileBytes) { skipped += Skipped(rel, SkipReason.TOO_LARGE); continue }
            val text = decodeUtf8(bytes)
            if (text == null || text.contains('\u0000')) { skipped += Skipped(rel, SkipReason.NOT_TEXT); continue }
            total += bytes.size
            files += CollectedFile(rel, pluginOf(rel), Lang.forPath(rel), bytes, text)
        }
        return CollectedFiles(files, skipped)
    }

    private fun walk(start: Path, candidates: MutableList<Path>, skipped: MutableList<Skipped>) {
        if (!Files.isDirectory(start, LinkOption.NOFOLLOW_LINKS)) return
        // walkFileTree without FOLLOW_LINKS reports links as files, so it never descends into them.
        Files.walkFileTree(start, emptySet(), policy.maxDepth + 1, object : SimpleFileVisitor<Path>() {
            override fun preVisitDirectory(dir: Path, attrs: BasicFileAttributes): FileVisitResult {
                if (dir == start) return FileVisitResult.CONTINUE
                val rel = guard.relativize(dir)
                return if (policy.isExcluded("$rel/x.yml") || attrs.isSymbolicLink || attrs.isOther) {
                    FileVisitResult.SKIP_SUBTREE
                } else {
                    FileVisitResult.CONTINUE
                }
            }

            override fun visitFile(file: Path, attrs: BasicFileAttributes): FileVisitResult {
                val rel = guard.relativize(file)
                val ext = ProtocolPaths.extensionOf(file.fileName.toString())
                if (ext !in ProtocolPaths.ALLOWED_EXTENSIONS || policy.isExcluded(rel)) return FileVisitResult.CONTINUE
                when {
                    attrs.isSymbolicLink -> skipped.add(Skipped(rel, SkipReason.SYMLINK))
                    !attrs.isRegularFile -> Unit
                    !policy.inScope(rel) -> skipped.add(Skipped(rel, SkipReason.UNSAFE_PATH))
                    else -> candidates.add(file)
                }
                return FileVisitResult.CONTINUE
            }

            override fun visitFileFailed(file: Path, exc: IOException): FileVisitResult {
                skipped += Skipped(guard.relativize(file), SkipReason.UNREADABLE)
                return FileVisitResult.CONTINUE
            }
        })
    }

    companion object {
        fun pluginOf(relative: String): String? {
            val segments = relative.split('/')
            return if (segments.size >= 3 && segments[0] == FilePolicy.PLUGINS) segments[1] else null
        }

        fun decodeUtf8(bytes: ByteArray): String? = try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes))
                .toString()
        } catch (_: CharacterCodingException) {
            null
        }
    }
}
