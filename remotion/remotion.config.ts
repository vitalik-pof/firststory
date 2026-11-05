import { Config } from "@remotion/cli/config";
import { existsSync } from "node:fs";

// Власний Chromium з контейнера, якщо Remotion не може завантажити свій браузер.
const CONTAINER_CHROMIUM = "/opt/pw-browsers/chromium";
if (process.env.REMOTION_BROWSER_EXECUTABLE) {
  Config.setBrowserExecutable(process.env.REMOTION_BROWSER_EXECUTABLE);
} else if (existsSync(CONTAINER_CHROMIUM)) {
  Config.setBrowserExecutable(CONTAINER_CHROMIUM);
}
Config.setChromiumDisableWebSecurity(false);
Config.setVideoImageFormat("jpeg");
