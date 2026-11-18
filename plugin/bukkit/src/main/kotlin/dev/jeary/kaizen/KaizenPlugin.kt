package dev.jeary.kaizen

import dev.jeary.kaizen.command.KaizenCommands
import dev.jeary.kaizen.config.ConfigException
import org.bukkit.plugin.java.JavaPlugin

class KaizenPlugin : JavaPlugin() {
    private var kaizen: Kaizen? = null

    override fun onEnable() {
        val k = Kaizen(this)
        try {
            k.load()
        } catch (e: ConfigException) {
            logger.severe("Kaizen can't start because of problems in its config:")
            e.errors.forEach { logger.severe("  • $it") }
            logger.severe("Fix them and restart the server (or reload the plugin).")
            k.shutdown()
            server.pluginManager.disablePlugin(this)
            return
        }
        kaizen = k
        KaizenCommands(k).register()
        k.startHousekeeping()
        logger.info("Kaizen ${description.version} ready · editor: ${k.settings.webUrl}")
    }

    override fun onDisable() {
        kaizen?.shutdown()
        kaizen = null
    }
}
