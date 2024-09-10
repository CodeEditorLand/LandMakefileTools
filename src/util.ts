// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

// Helper APIs used by this extension

import * as configuration from "./configuration";
import * as fs from "fs";
import * as child_process from "child_process";
import * as logger from "./logger";
import * as make from "./make";
import * as path from "path";
import * as telemetry from "./telemetry";
import * as vscode from "vscode";

import * as nls from "vscode-nls";
import { extension } from "./extension";
nls.config({
  messageFormat: nls.MessageFormat.bundle,
  bundleFormat: nls.BundleFormat.standalone,
})();
const localize: nls.LocalizeFunc = nls.loadMessageBundle();

// C/CPP standard versions
export type StandardVersion =
  | "c89"
  | "c99"
  | "c11"
  | "c17"
  | "c++98"
  | "c++03"
  | "c++11"
  | "c++14"
  | "c++17"
  | "c++20"
  | "c++23"
  | "gnu89"
  | "gnu99"
  | "gnu11"
  | "gnu17"
  | "gnu++98"
  | "gnu++03"
  | "gnu++11"
  | "gnu++14"
  | "gnu++17"
  | "gnu++20"
  | "gnu++23"
  | undefined;

// Supported target architectures (for code generated by the compiler)
export type TargetArchitecture = "x86" | "x64" | "arm" | "arm64" | undefined;

// IntelliSense modes
export type IntelliSenseMode =
  | "msvc-x64"
  | "msvc-x86"
  | "msvc-arm"
  | "msvc-arm64"
  | "gcc-x64"
  | "gcc-x86"
  | "gcc-arm"
  | "gcc-arm64"
  | "clang-x64"
  | "clang-x86"
  | "clang-arm"
  | "clang-arm64"
  | undefined;

// Language types
export type Language = "c" | "cpp" | undefined;

export function checkFileExistsSync(filePath: string): boolean {
  try {
    // Often a path is added by the user to the PATH environment variable with surrounding quotes,
    // especially on Windows where they get automatically added after TAB.
    // These quotes become inner (not surrounding) quotes after we append various file names or do oher processing,
    // making file sysem stats fail. Safe to remove here.
    let filePathUnq: string = filePath;
    filePathUnq = removeQuotes(filePathUnq);
    return fs.statSync(filePathUnq).isFile();
  } catch (e) {}
  return false;
}

export function checkDirectoryExistsSync(directoryPath: string): boolean {
  try {
    return fs.statSync(directoryPath).isDirectory();
  } catch (e) {}
  return false;
}

export function createDirectorySync(directoryPath: string): boolean {
  try {
    fs.mkdirSync(directoryPath, { recursive: true });
    return true;
  } catch {}
  return false;
}

export function deleteFileSync(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (e) {}
}

export function readFile(filePath: string): string | undefined {
  try {
    if (checkFileExistsSync(filePath)) {
      return fs.readFileSync(filePath).toString();
    }
  } catch (e) {}

  return undefined;
}

export function writeFile(
  filePath: string,
  content: string
): string | undefined {
  try {
    fs.writeFileSync(filePath, content);
  } catch (e) {}

  return undefined;
}

// Get the platform-specific temporary directory
export function tmpDir(): string {
  if (process.platform === "win32") {
    return process.env["TEMP"] || "";
  } else {
    const xdg = process.env["XDG_RUNTIME_DIR"];
    if (xdg) {
      if (!fs.existsSync(xdg)) {
        fs.mkdirSync(xdg);
      }
      return xdg;
    }
    return "/tmp";
  }
}

// Returns the full path to a temporary script generated by the extension
// and used to parse any additional compiler switches that need to be sent to CppTools.
export function parseCompilerArgsScriptFile(): string {
  const extensionPath = extension.extensionContext.extensionPath;
  let scriptFile: string = path.join(
    extensionPath,
    "assets",
    "parseCompilerArgs"
  );

  if (process.platform === "win32") {
    scriptFile += ".bat";
  } else {
    scriptFile += ".sh";
  }

  return scriptFile;
}

export function getWorkspaceRoot(): string {
  return vscode.workspace.workspaceFolders
    ? vscode.workspace.workspaceFolders[0].uri.fsPath
    : "";
}

// Evaluate whether a string looks like a path or not,
// without using fs.stat, since dry-run may output tools
// that are not found yet at certain locations,
// without running the prep targets that would copy them there
export function looksLikePath(pathStr: string): boolean {
  // TODO: to be implemented
  return true;
}

// Evaluate whether the tool is invoked from the current directory
export function pathIsCurrentDirectory(pathStr: string): boolean {
  // Ignore any spaces or tabs before the invocation
  pathStr = pathStr.trimLeft();

  if (pathStr === "") {
    return true;
  }

  if (process.platform === "win32" && process.env.MSYSTEM === undefined) {
    if (pathStr === ".\\") {
      return true;
    }
  } else {
    if (pathStr === "./") {
      return true;
    }
  }

  return false;
}

// Helper that searches for a tool in all the paths forming the PATH environment variable
// Returns the first one found or undefined if not found.
// TODO: implement a variation of this helper that scans on disk for the tools installed,
// to help when VSCode is not launched from the proper environment
export function toolPathInEnv(name: string): string | undefined {
  let envPath: string | undefined = process.env["PATH"];
  let envPathSplit: string[] = [];
  if (envPath) {
    envPathSplit = envPath.split(path.delimiter);
  }

  // todo: if the compiler is not found in path, scan on disk and point the user to all the options
  // (the concept of kit for cmake extension)

  return envPathSplit.find((p) => {
    const fullPath: string = path.join(p, path.basename(name));
    if (checkFileExistsSync(fullPath)) {
      return fullPath;
    }
  });
}

function taskKill(pid: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child_process.exec(`taskkill /pid ${pid} /T /F`, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

export async function killTree(
  progress: vscode.Progress<{}>,
  pid: number
): Promise<void> {
  if (process.platform === "win32") {
    try {
      await taskKill(pid);
    } catch (e) {
      logger.message(
        localize(
          "failed.to.kill.process",
          "Failed to kill process {0}: {1}",
          pid,
          e
        )
      );
    }
    return;
  }

  let children: number[] = [];
  let stdoutStr: string = "";

  let stdout: any = (result: string): void => {
    stdoutStr += result;
  };

  try {
    // pgrep should run on english, regardless of the system setting.
    const result: SpawnProcessResult = await spawnChildProcess(
      "pgrep",
      ["-P", pid.toString()],
      getWorkspaceRoot(),
      true,
      false,
      stdout
    );
    if (!!stdoutStr.length) {
      children = stdoutStr
        .split("\n")
        .map((line: string) => Number.parseInt(line));

      logger.message(
        localize(
          "found.children.subprocesses",
          "Found children subprocesses: {0}.",
          stdoutStr
        )
      );
      for (const other of children) {
        if (other) {
          await killTree(progress, other);
        }
      }
    }
  } catch (e) {
    logger.message(e.message);
    throw e;
  }

  try {
    logger.message(
      localize("killing.process", "Killing process PID = {0}", pid)
    );
    progress.report({
      increment: 1,
      message: localize(
        "utils.terminate.process",
        "Terminating process PID=${0} ...",
        pid
      ),
    });
    process.kill(pid, "SIGINT");
  } catch (e) {
    if (e.code !== "ESRCH") {
      throw e;
    }
  }
}

// Environment variables helpers (inspired from CMake Tools utils).
export interface EnvironmentVariables {
  [key: string]: string;
}

export function normalizeEnvironmentVarname(varname: string): string {
  return process.platform === "win32" ? varname.toUpperCase() : varname;
}

export function mergeEnvironment(
  ...env: EnvironmentVariables[]
): EnvironmentVariables {
  return env.reduce((acc, vars) => {
    if (process.platform === "win32") {
      // Env vars on windows are case insensitive, so we take the ones from
      // active env and overwrite the ones in our current process env
      const norm_vars: EnvironmentVariables = Object.getOwnPropertyNames(
        vars
      ).reduce<EnvironmentVariables>((acc2, key: string) => {
        acc2[normalizeEnvironmentVarname(key)] = vars[key];
        return acc2;
      }, {});
      return { ...acc, ...norm_vars };
    } else {
      return { ...acc, ...vars };
    }
  }, {});
}

export interface SpawnProcessResult {
  returnCode: number;
  signal: string;
}

// Helper to spawn a child process, hooked to callbacks that are processing stdout/stderr
// forceEnglish is true when the caller relies on parsing english words from the output.
export function spawnChildProcess(
  processName: string,
  args: string[],
  workingDirectory: string,
  forceEnglish: boolean,
  ensureQuoted: boolean,
  stdoutCallback?: (stdout: string) => void,
  stderrCallback?: (stderr: string) => void
): Promise<SpawnProcessResult> {
  const localeOverride: EnvironmentVariables = {
    LANG: "C",
    LC_ALL: "C",
  };

  // Use english language for this process regardless of the system setting.
  const environment: EnvironmentVariables = forceEnglish ? localeOverride : {};
  const finalEnvironment: EnvironmentVariables = mergeEnvironment(
    process.env as EnvironmentVariables,
    environment
  );

  return new Promise<SpawnProcessResult>((resolve, reject) => {
    // Honor the "terminal.integrated.automationShell.<platform>" setting.
    // According to documentation (and settings.json schema), the three allowed values for <platform> are "windows", "linux" and "osx".
    // child_process.SpawnOptions accepts a string (which can be read from the above setting) or the boolean true to let VSCode pick a default
    // based on where it is running.
    let shellType: string | undefined;
    let shellPlatform: string =
      process.platform === "win32"
        ? "windows"
        : process.platform === "linux"
        ? "linux"
        : "osx";
    let workspaceConfiguration: vscode.WorkspaceConfiguration =
      vscode.workspace.getConfiguration("terminal");
    shellType =
      workspaceConfiguration.get<string>(
        `integrated.automationProfile.${shellPlatform}`
      ) || // automationShell is deprecated
      workspaceConfiguration.get<string>(
        `integrated.automationShell.${shellPlatform}`
      ); // and replaced with automationProfile

    // Final quoting decisions for process name and args before being executed.
    let qProcessName: string = ensureQuoted
      ? quoteStringIfNeeded(processName)
      : processName;
    let qArgs: string[] = ensureQuoted
      ? args.map((arg) => {
          return quoteStringIfNeeded(arg);
        })
      : args;

    if (ensureQuoted) {
      logger.message(
        localize(
          "utils.quoting",
          "Spawning child process with:\n process name: {0}\n process args: {1}\n working directory: {2}\n shell type: {3}",
          qProcessName,
          qArgs.join(","),
          workingDirectory,
          shellType || "default"
        ),
        "Debug"
      );
    }

    const child: child_process.ChildProcess = child_process.spawn(
      qProcessName,
      qArgs,
      { cwd: workingDirectory, shell: shellType || true, env: finalEnvironment }
    );
    make.setCurPID(child.pid);

    if (stdoutCallback) {
      child.stdout.on("data", (data) => {
        stdoutCallback(`${data}`);
      });
    }

    if (stderrCallback) {
      child.stderr.on("data", (data) => {
        stderrCallback(`${data}`);
      });
    }

    child.on("close", (returnCode: number, signal: string) => {
      resolve({ returnCode, signal });
    });

    child.on("exit", (returnCode: number) => {
      resolve({ returnCode, signal: "" });
    });

    if (child.pid === undefined) {
      reject(new Error(`Failed to spawn process: ${processName} ${args}`));
    }
  });
}

// Helper to eliminate empty items in an array
export function dropNulls<T>(items: (T | null | undefined)[]): T[] {
  return items.filter((item) => item !== null && item !== undefined) as T[];
}

// Convert a posix path (/home/dir1/dir2/file.ext) into windows path,
// by calling the cygpah which comes installed with MSYS/MinGW environments
// and which is also aware of the drive under which /home/ is placed.
// result: c:\msys64\home\dir1\dir2\file.ext
// Called usually for Windows subsystems: MinGW, CygWin.
export async function cygpath(pathStr: string): Promise<string> {
  let windowsPath: string = pathStr;

  let stdout: any = (result: string): void => {
    windowsPath = result.replace(/\n/gm, ""); // remove the end of line
  };

  // Running cygpath can use the system locale.
  await spawnChildProcess("cygpath", [pathStr, "-w"], "", false, false, stdout);
  return windowsPath;
}

// Helper that transforms a posix path (used in various non windows environments on a windows system)
// into a windows style path.
export async function ensureWindowsPath(path: string): Promise<string> {
  if (process.platform !== "win32" || !path.startsWith("/")) {
    return path;
  }

  let winPath: string = path;

  if (process.env.MSYSTEM !== undefined) {
    // When in MSYS/MinGW/CygWin environments, cygpath can help transform into a windows path
    // that we know CppTools will use when querying us.
    winPath = await cygpath(winPath);
  } else {
    // Even in a pure windows environment, there are tools that may report posix paths.
    // Instead of searching a cygpath tool somewhere, do the most basic transformations:

    // Mount drives names like "cygdrive" or "mnt" can be ignored.
    const mountDrives: string[] = ["cygdrive", "mnt"];
    for (const drv of mountDrives) {
      if (winPath.startsWith(`/${drv}`)) {
        winPath = winPath.substr(drv.length + 1);

        // Exit the loop, because we don't want to remove anything else
        // in case the path happens to follow with a subfolder with the same name
        // as other mountable drives for various systems/environments.
        break;
      }
    }

    // Remove the slash and add the : for the drive.
    winPath = winPath.substr(1);
    const driveEndIndex: number = winPath.search("/");
    winPath =
      winPath.substring(0, driveEndIndex) + ":" + winPath.substr(driveEndIndex);

    // Replace / with \.
    winPath = winPath.replace(/\//gm, "\\");
  }

  return winPath;
}

// Helper to reinterpret one relative path (to the given current path) printed by make as full path
export async function makeFullPath(
  relPath: string,
  curPath: string | undefined
): Promise<string> {
  let fullPath: string = relPath;

  if (!path.isAbsolute(fullPath) && curPath) {
    fullPath = path.join(curPath, relPath);
  }

  // For win32, ensure we have a windows style path.
  fullPath = await ensureWindowsPath(fullPath);

  return fullPath;
}

// Helper to reinterpret the relative paths (to the given current path) printed by make as full paths
export async function makeFullPaths(
  relPaths: string[],
  curPath: string | undefined
): Promise<string[]> {
  let fullPaths: string[] = [];

  for (const p of relPaths) {
    let fullPath: string = await makeFullPath(p, curPath);
    fullPaths.push(fullPath);
  }

  return fullPaths;
}

// Helper to reinterpret one full path as relative to the given current path
export function makeRelPath(
  fullPath: string,
  curPath: string | undefined
): string {
  let relPath: string = fullPath;

  if (path.isAbsolute(fullPath) && curPath) {
    relPath = path.relative(curPath, fullPath);
  }

  return relPath;
}

// Helper to reinterpret the relative paths (to the given current path) printed by make as full paths
export function makeRelPaths(
  fullPaths: string[],
  curPath: string | undefined
): string[] {
  let relPaths: string[] = [];

  fullPaths.forEach((p) => {
    relPaths.push(makeRelPath(p, curPath));
  });

  return fullPaths;
}

// Helper to remove any quotes(", ' or `) from a given string
// because many file operations don't work properly with paths
// having quotes in the middle.
const quotesStr: string[] = ["'", '"', "`"];
export function removeQuotes(str: string): string {
  for (const p in quotesStr) {
    if (str.includes(quotesStr[p])) {
      let regExpStr: string = `${quotesStr[p]}`;
      let regExp: RegExp = RegExp(regExpStr, "g");
      str = str.replace(regExp, "");
    }
  }

  return str;
}

// Remove only the quotes (", ' or `) that are surrounding the given string.
export function removeSurroundingQuotes(str: string): string {
  let result: string = str.trim();
  for (const p in quotesStr) {
    if (result.startsWith(quotesStr[p]) && result.endsWith(quotesStr[p])) {
      result = result.substring(1, str.length - 1);
      return result;
    }
  }

  return str;
}

// Quote given string if it contains space and is not quoted already
export function quoteStringIfNeeded(str: string): string {
  // No need to quote if there is no space or ampersand present.
  if (!str.includes(" ") && !str.includes("&")) {
    return str;
  }

  // Return if already quoted.
  for (const q in quotesStr) {
    if (str.startsWith(quotesStr[q]) && str.endsWith(quotesStr[q])) {
      return str;
    }
  }

  // Quote and return.
  return `"${str}"`;
}

// Used when constructing a regular expression from file names which can contain
// special characters (+, ", ...etc...).
const escapeChars: RegExp = /[\\\^\$\*\+\?\{\}\(\)\.\!\=\|\[\]\ \/]/; // characters that should be escaped.
export function escapeString(str: string): string {
  let escapedString: string = "";
  for (const char of str) {
    if (char.match(escapeChars)) {
      escapedString += `\\${char}`;
    } else {
      escapedString += char;
    }
  }
  return escapedString;
}

export function elapsedTimeSince(start: number): number {
  // Real elapsed times not useful in testing mode and we want to avoid diffs.
  // We could alternatively disable the messages from being printed.
  return process.env["MAKEFILE_TOOLS_TESTING"] === "1"
    ? 0
    : (Date.now() - start) / 1000;
}

// Helper to evaluate whether two settings (objects or simple types) represent the same content.
// It recursively analyzes any inner subobjects and is also not affected
// by a different order of properties.
export function areEqual(setting1: any, setting2: any): boolean {
  if (
    setting1 === null ||
    setting1 === undefined ||
    setting2 === null ||
    setting2 === undefined
  ) {
    return setting1 === setting2;
  }

  // This is simply type
  if (
    typeof setting1 !== "function" &&
    typeof setting1 !== "object" &&
    typeof setting2 !== "function" &&
    typeof setting2 !== "object"
  ) {
    return setting1 === setting2;
  }

  let properties1: string[] = Object.getOwnPropertyNames(setting1);
  let properties2: string[] = Object.getOwnPropertyNames(setting2);

  if (properties1.length !== properties2.length) {
    return false;
  }

  for (let p: number = 0; p < properties1.length; p++) {
    let property: string = properties1[p];
    let isEqual: boolean;
    if (
      typeof setting1[property] === "object" &&
      typeof setting2[property] === "object"
    ) {
      isEqual = areEqual(setting1[property], setting2[property]);
    } else {
      isEqual = setting1[property] === setting2[property];
    }

    if (!isEqual) {
      return false;
    }
  }

  return true;
}

// Answers whether the given object has at least one property.
export function hasProperties(obj: any): boolean {
  if (obj === null || obj === undefined) {
    return false;
  }

  let props: string[] = Object.getOwnPropertyNames(obj);
  return props && props.length > 0;
}

// Apply any properties from source to destination, logging for overwrite.
// To make things simpler for the caller, create a valid dst if given null or undefined.
export function mergeProperties(dst: any, src: any): any {
  let props: string[] = src ? Object.getOwnPropertyNames(src) : [];
  props.forEach((prop) => {
    if (!dst) {
      dst = {};
    }

    if (dst[prop] !== undefined) {
      logger.message(
        localize(
          "utils.overwriting.property",
          "Destination object already has property {0} set to {1}. Overwriting from source with {2}",
          prop,
          dst[prop],
          src[prop]
        ),
        "Debug"
      );
    }

    dst[prop] = src[prop];
  });

  return dst;
}
export function removeDuplicates(src: string[]): string[] {
  let seen: { [key: string]: boolean } = {};
  let result: string[] = [];
  src.forEach((item) => {
    if (!seen[item]) {
      seen[item] = true;
      result.push(item);
    }
  });

  return result;
}

export function sortAndRemoveDuplicates(src: string[]): string[] {
  return removeDuplicates(src.sort());
}

export function reportDryRunError(dryrunOutputFile: string): void {
  logger.message(
    localize(
      "utils.dryrun.detailed.output",
      "You can see the detailed dry-run output at {0}",
      dryrunOutputFile
    )
  );
  logger.message(
    localize(
      "utils.dryrun.error.environment",
      "Make sure that the extension is invoking the same make command as in your development prompt environment."
    )
  );
  logger.message(
    localize(
      "utils.dryrun.error.makefile",
      "You may need to define or tweak a custom makefile configuration in settings via 'makefile.configurations' like described here: [link]"
    )
  );
  logger.message(
    localize(
      "utils.dryrun.error.knownissues",
      "Also make sure your code base does not have any known issues with the dry-run switches used by this extension (makefile.dryrunSwitches)."
    )
  );
  logger.message(
    localize(
      "utils.dryrun.error.github",
      "If you are not able to fix the dry-run, open a GitHub issue in Makefile Tools repo: https://github.com/microsoft/vscode-makefile-tools/issues"
    )
  );
}

// Helper to make paths absolute until the extension handles variables expansion.
export function resolvePathToRoot(relPath: string): string {
  if (!path.isAbsolute(relPath)) {
    return path.join(getWorkspaceRoot(), relPath);
  }

  return relPath;
}

// Return the string representing the user home location.
// Inspired from CMake Tools. TODO: implement more such paths and refactor into a separate class.
export function userHome(): string {
  if (process.platform === "win32") {
    return path.join(
      process.env["HOMEDRIVE"] || "C:",
      process.env["HOMEPATH"] || "Users\\Public"
    );
  } else {
    return process.env["HOME"] || process.env["PROFILE"] || "";
  }
}

// Helper to correctly interpret boolean values out of strings.
// Currently used during settings variable expansion.
export function booleanify(value: string): boolean {
  const truthy: string[] = ["true", "True", "1"];
  return truthy.includes(value);
}

// Read setting from workspace settings and expand according to various supported patterns.
// Do this for the simple types (converting to boolean or numerals when the varexp syntax
// is used on such types of settings) and for arrays or objects, expand recursively
// until we reach the simple types for submembers. This handles any structure.
export async function getExpandedSetting<T>(
  settingId: string,
  propSchema?: any
): Promise<T | undefined> {
  let workspaceConfiguration: vscode.WorkspaceConfiguration =
    vscode.workspace.getConfiguration("makefile");
  let settingVal: any | undefined = workspaceConfiguration.get<T>(settingId);

  if (!propSchema) {
    propSchema = thisExtensionPackage().contributes.configuration.properties;
    propSchema = propSchema.properties
      ? propSchema.properties[`makefile.${settingId}`]
      : propSchema[`makefile.${settingId}`];
  }

  // Read what's at settingId in the workspace settings and for objects and arrays of complex types make sure
  // to copy into a new counterpart that we will modify, because we don't want to persist expanded values in settings.
  let copySettingVal: any | undefined;
  if (propSchema && propSchema.type === "array") {
    // A simple .concat() is not enough. We need to push(Object.assign) on all object entries in the array.
    copySettingVal = [];
    (settingVal as any[]).forEach((element) => {
      let copyElement: any = {};
      copyElement =
        typeof element === "object"
          ? Object.assign(copyElement, element)
          : element;
      copySettingVal.push(copyElement);
    });
  } else if (propSchema && propSchema.type === "object") {
    copySettingVal = {};
    copySettingVal = Object.assign(copySettingVal, settingVal);
  } else {
    copySettingVal = settingVal;
  }

  return getExpandedSettingVal<T>(settingId, copySettingVal, propSchema);
}

// Same as above but read from an object instead of the settings (as if we get<> before calling this).
// Such approach was needed for tests.
export async function getExpandedSettingVal<T>(
  settingId: string,
  settingVal: any,
  propSchema?: any
): Promise<T | undefined> {
  // Currently, we have no ${} variables in the default values of our settings.
  // Skip expanding defaults to keep things faster simpler and safer.
  // Change this when needed.
  const typeJson: string | undefined = propSchema ? propSchema.type : undefined;
  if (
    settingVal !== undefined &&
    ((propSchema && !areEqual(propSchema.default, settingVal)) || !propSchema)
  ) {
    // This OR is for variables not defined in the extension package.json
    // but the user can define any variable in settings.json to reference later
    if (typeof settingVal === "string") {
      const expandedVal: string = await expandVariablesInSetting(
        settingId,
        settingVal
      );
      let result: T = expandedVal as T;
      if (typeJson === "boolean") {
        result = booleanify(expandedVal) as T;
      } else if (typeJson === "number" || typeJson === "integer") {
        result = Number(expandedVal) as T;
      }

      return result;
    } else if (typeof settingVal === "object") {
      // arrays are also seen as objects:
      // example: array[5] is seen as property object with index array.5
      // and at the next call we'll see the string.
      let properties: string[] = Object.getOwnPropertyNames(settingVal);
      for (let p: number = 0; p < properties.length; p++) {
        let prop: string = properties[p];
        let childPropSchema: any;
        if (propSchema) {
          if (typeJson === "array") {
            childPropSchema = propSchema.items;
          } else {
            childPropSchema = propSchema.properties
              ? propSchema.properties[`${prop}`]
              : propSchema[`${prop}`];
          }
        }

        try {
          // The settingVal that was given to this function was already a separate copy from its workspace settings counterpart
          // but if that contained an array anywhere in its structure, if we don't copy here, this expansion will modify
          // workspace settings which we want to leave untouched.
          let copySettingValProp: any = settingVal[prop];
          if (childPropSchema && childPropSchema.type === "array") {
            copySettingValProp = [].concat(settingVal[prop]);
          }

          let expandedProp: T = await getExpandedSettingVal<
            typeof childPropSchema
          >(settingId + "." + prop, copySettingValProp, childPropSchema);
          if (!areEqual(settingVal[prop], expandedProp)) {
            settingVal[prop] = expandedProp;
          }
        } catch (e) {
          logger.message(
            localize(
              "utils.exception.expanding",
              'Exception while expanding string "{0}.{1}": "{2}"',
              settingId,
              prop,
              e.message
            )
          );
        }
      }
    }
  }

  return settingVal;
}

// Helper for expanding variables in a setting. The following scenarios are currently supported:
// - predefined VSCode variables (more should be supported with the next release):
//       ${workspaceFolder} (which is the same as the deprecated ${workspaceRoot} which we still support),
//       ${workspaceFolderBasename}, ${userHome}
// - special Makefile Tools variables (implement more in future):
//       ${configuration}, ${buildTarget} (these map to the first two UI elements in the "C/C++" left panel)
// - environment variables: ${env:USERNAME}
// - (any extensions) configuration variables: ${config:extension.setting}
// - command variables: ${command:extension.command} (currently, without commands input variables support)
// - allow for escaping a varexp sequence in case the user wants to pass that through as is.
//   The escape character is backslash and in json one backslash is not allowed inside a string, so we'll always get double.
//   When used in paths, we can't know if a \\ is wanted as a path separator or an escape character so we assume
//   it is always an escape character. Whenever this is not the case, the user can switch to forward slashes in the paths.
//   Example: "drive:\\folder1\\folder2_\\${variable}\\folder3" may be wanted as "drive:\\folder1\\folder2_\\value\\folder3"
//   or as "drive:\\folder1\\folder2_${variable}\\folder3". $ does not make much sense to be left in a path
//   but also the analysis of the meaning of a string (especially if not full path) is not simple.
//   Forward slashes are recommended in paths.
//       NOTES:
//       - ${command:makefile.getConfiguration} is the same as ${configuration}
//       - ${command:makefile.getBuildTarget} is the same as ${buildTarget}
//       - we need the above two commands because launch.json and tasks.json
//         don't work with our predefined variables, only with the VSCode predefined variables.
//         Such data is useful to be accessible to launch/tasks jsons too.
//         But settings.json works with our predefined variables, VSCode predefined variables
//         and any commands.
// TODO: Currently, after applying any expansion pattern, if the result is another expansion pattern
// we log an error but in future let's handle the recursivity and complications of expanding anything
// coming via this entrypoint.
export async function expandVariablesInSetting(
  settingId: string,
  settingVal: string
): Promise<string> {
  // Do some string preprocessing first, related to escaping.
  // Since we don't want to change the value persisted in settings but we need to lose the separator
  // (so that the final beneficiaries of these settings don't need to handle the separator character)
  // we will keep the varexp pattern in the final value without the escape character.
  // The escape character is only for our regexp here to know to not expand it.
  // Safe to replace \\${ with ESCAPED_VARIABLE_EXPANSION. This will cause the pattern to be skipped
  // by the regular expression below and also we will replace in reverse at the end (without \\).
  const telemetryProperties: telemetry.Properties = { setting: settingId };
  let preprocStr: string = settingVal.replace(
    /\\\$\{/gm,
    "ESCAPED_VARIABLE_EXPANSION"
  );
  if (preprocStr !== settingVal) {
    logger.message(
      localize(
        "detected.escape.patterns",
        "Detected escaped variable expansion patterns in setting '{0}', within value '{1}'.",
        settingId,
        settingVal
      )
    );
    telemetryProperties.pattern = "escaped";
    telemetry.logEvent("varexp", telemetryProperties);
    settingVal = preprocStr;
  }

  // Try the predefined VSCode variable first. The regexp for ${variable} won't fit the others because of the ":".
  let expandedSetting: string = settingVal;
  let regexpVSCodeVar: RegExp = /(\$\{(\w+)\})|(\$\{(\w+):(.+?)\})/gm;
  let result: RegExpExecArray | null = regexpVSCodeVar.exec(expandedSetting);
  while (result) {
    const telemetryProperties: telemetry.Properties = { setting: settingId };
    let toStr: string = "";
    if (result[2] === "workspaceFolder" || result[2] === "workspaceRoot") {
      toStr = getWorkspaceRoot();
      telemetryProperties.pattern = result[2];
    } else if (result[2] === "workspaceFolderBasename") {
      toStr = path.basename(getWorkspaceRoot());
      telemetryProperties.pattern = result[2];
    } else if (result[2] === "userHome") {
      toStr = userHome();
      telemetryProperties.pattern = result[2];
    } else if (result[2] === "configuration") {
      toStr = configuration.getCurrentMakefileConfiguration();
      telemetryProperties.pattern = result[2];
    } else if (result[2] === "buildTarget") {
      toStr = configuration.getCurrentTarget() || "";
      telemetryProperties.pattern = result[2];
    } else if (result[4] === "env" && result[5]) {
      toStr = process.env[result[5]] || "";
      telemetryProperties.pattern = result[4];
    } else if (result[4] === "command") {
      telemetryProperties.pattern = result[4];
      telemetryProperties.info = result[5];
      try {
        toStr = await vscode.commands.executeCommand(result[5]);
      } catch (e) {
        toStr = "unknown";
        logger.message(
          localize(
            "exception.executing",
            "Exception while executing command \"{0}\": '{1}'",
            result[5],
            e.message
          )
        );
      }
    } else if (result[4] === "config" && result[5]) {
      // Extract the name of the extension we read this setting from (before the dot)
      // and the setting follows the first dot.
      telemetryProperties.pattern = result[4];
      telemetryProperties.info = result[5];
      const regexpCfg: RegExp = /(\w+)\.(.+)/gm;
      const res: RegExpExecArray | null = regexpCfg.exec(result[5]);
      if (res && res[1] && res[2]) {
        let workspaceCfg: vscode.WorkspaceConfiguration =
          vscode.workspace.getConfiguration(res[1]);
        toStr = workspaceCfg.get(res[2]) as string;

        // The setting is either undefined or maybe we encountered a case with multiple names separated by dot for a property:
        // makefile.set1.set2.set3.set4... which cannot be seen if given the whole setting ID at once.
        // Example:
        // "makefile.set1.set2.set3": {
        //     "set4.set5": "val"
        //     "something.else": "other"
        // }
        // A get on the root workspace cannot see "makefile.set1.set2.set3.set4.set5", returns undefined.
        // In the above case, one get of "makefile.set1.set2.set3" returns an object, then an access on "set4.set5" gets the final value "val".
        // We don't know at which dot to stop for the first and the subsequent get operations, so starting with the workspace root
        // we query for properties and see how much it matches from the full setting id, then we query again on the left over,
        // until we get the final value.
        // In the above case, the root makefile workspace has a property set1 (not set1.set2.set3), then the object retrieved
        // has a set2 property then set3. That last object has a "set4.set5" property (not set4 then set5).
        if (toStr === null || toStr === undefined) {
          toStr = getSettingMultipleDots(workspaceCfg, res[2]);
        }

        if (toStr === null || toStr === undefined) {
          toStr = "unknown";
        }
      }
    } else {
      logger.message(
        localize(
          "unrecognized.variable.format",
          "Unrecognized variable format: {0}",
          result[0]
        )
      );
      toStr = "unknown";
      telemetryProperties.pattern = "unrecognized";
    }

    telemetry.logEvent("varexp", telemetryProperties);

    // Because we replace at the same time as we evaluate possible consecutive $ patterns
    // we need to start each time the search from the beginning (otherwise the lastIndex gets messed up).
    // It is guaranteed we exit this loop because if we match, we replace with something.
    // That is why we cannot leave the ${} as they are and we replace with "unknown" when they can't resolve.
    // Replacing with empty string was not an option because we want unrecognized patterns to stand out quickly.
    regexpVSCodeVar.lastIndex = 0;

    // Warn if the expanded value contains yet another expansion pattern and leave as is.
    // We will address in future multiple passes.
    if (regexpVSCodeVar.exec(toStr) !== null) {
      logger.message(
        localize(
          "multiple.expansion.passes",
          '"{0}" resolves to "{1}" which requires another expansion. We will support multiple expansion passes in the future.',
          result[0],
          toStr
        )
      );
      expandedSetting = expandedSetting.replace(result[0], "unknown");
    } else {
      expandedSetting = expandedSetting.replace(result[0], toStr);
    }

    regexpVSCodeVar.lastIndex = 0;
    result = regexpVSCodeVar.exec(expandedSetting);
  }

  if (expandedSetting !== settingVal) {
    logger.message(
      localize(
        "expanding.setting",
        "Expanding from '{0}' to '{1}' for setting '{2}'.",
        settingVal,
        expandedSetting,
        settingId
      )
    );
  }

  // Reverse the preprocessing done at the beginning, except that we don't keep the escape character.
  preprocStr = expandedSetting.replace(/ESCAPED_VARIABLE_EXPANSION/gm, "${");
  return preprocStr;
}

// Function specialized to get properties with multiple dots in their names.
// In case of more possibilities, return last.
// Example: get the value of "makefile.panel.visibility" or a general hypothetic setting like
// "makefile.set1.set2.set3.set4": {
//      "set5.set6": "val1",
//      "set7.set8": "val2"
// }
// getSettingMultipleDots will return "val2" for "makefile.set1.set2.set3.set4.set7.set8"
// and workspaceConfiguration.get<> will not see it as a whole.
function getSettingMultipleDots(scope: any, settingId: string): any {
  let result: any;
  if (scope) {
    let rootProps: string[] = Object.getOwnPropertyNames(scope);
    rootProps = rootProps.filter(
      (item) => item && (settingId.startsWith(`${item}.`) || settingId === item)
    );
    rootProps.forEach((prop) => {
      if (settingId === prop) {
        result = scope[prop];
      } else {
        result = getSettingMultipleDots(
          scope[prop],
          settingId.substring(prop.length + 1, settingId.length)
        );
      }
    });
  }

  return result;
}

// Schedule a task to be run at some future time. This allows other pending tasks to
// execute ahead of the scheduled task and provides a form of async behavior for TypeScript.
export function scheduleTask<T>(task: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setImmediate(() => {
      try {
        const result: T = task();
        resolve(result);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Async version of scheduleTask
export async function scheduleAsyncTask<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    setImmediate(async () => {
      try {
        const result: T = await task();
        resolve(result);
      } catch (e) {
        reject(e);
      }
    });
  });
}

export function thisExtension(): vscode.Extension<any> {
  const ext: vscode.Extension<any> | undefined = vscode.extensions.getExtension(
    "ms-vscode.makefile-tools"
  );
  if (!ext) {
    throw new Error("Our own extension is null.");
  }

  return ext;
}

export interface PackageJSON {
  name: string;
  publisher: string;
  version: string;
  contributes: any;
}

export function thisExtensionPackage(): PackageJSON {
  const pkg: PackageJSON = thisExtension().packageJSON as PackageJSON;

  return {
    name: pkg.name,
    publisher: pkg.publisher,
    version: pkg.version,
    contributes: pkg.contributes,
  };
}

export function thisExtensionPath(): string {
  return thisExtension().extensionPath;
}
