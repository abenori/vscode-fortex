import { defineConfig } from '@vscode/test-cli';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const installedVSCode = [
	process.env.VSCODE_EXECUTABLE_PATH,
	process.platform === 'win32' && process.env.LOCALAPPDATA
		? join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe')
		: undefined,
	process.platform === 'win32' && process.env.ProgramFiles
		? join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe')
		: undefined,
].find(candidate => candidate && existsSync(candidate));

export default defineConfig({
	files: 'out/test/**/*.test.js',
	...(installedVSCode
		? { useInstallation: { fromPath: installedVSCode } }
		: {}),
});
