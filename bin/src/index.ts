#! /usr/bin/env node
import chokidar from "chokidar";
import fs from "fs";
import path from "path";
import yargs from "yargs";
import build from "../../src/build";
import parse from "../../src/parse";
import tokenize from "../../src/tokenize";
import Config from "./types/Config";

const SUPPORTED_EXTENSION = ".lang";

//(async () => {
try {
  console.log("\n~ LANG CLI ~\n");

  const options = yargs
    .usage("Usage: lang --in [file/folder]")
    .option("in", {
      alias: "i",
      describe: "Input file or folder",
      type: "string",
      demandOption: true,
    })
    .option("out", {
      alias: "o",
      describe: "Output file",
      type: "string",
      demandOption: false,
    })
    .option("config", {
      alias: "c",
      describe: "The path to a config file",
      type: "string",
      demandOption: false,
    })
    .option("watch", {
      alias: "w",
      describe: "Whether to watch for file changes",
      type: "boolean",
      demandOption: false,
    })
    .help(true)
    .parseSync();

  // Does the --in path exist
  if (fs.existsSync(options.in)) {
    // Does the --config path exist
    let config: Config = {};
    if (options.config && fs.existsSync(options.config)) {
      // TODO: Support a js/ts config file as well as JSON
      //config = await import(options.config);
      config = JSON.parse(fs.readFileSync(options.config, "utf-8"));
    }

    // Is the --in path a folder
    if (fs.lstatSync(options.in).isDirectory()) {
      // Loop through files in the folder
      //processFolder(options.in);
      if (options.watch) {
        watchPath(options.in, config);
      } else {
        processFolder(options.in, config);
      }
    } else {
      // Process the supplied file
      const extname = path.extname(options.in);
      if (shouldProcessFile(options.in)) {
        //processFile(options.in);
        // NOTE: We get add notifications for all watched files immediately
        // TODO: Is this the case on Windows etc too?
        if (options.watch) {
          watchPath(options.in, config);
        } else {
          processFile(options.in, config);
        }
      } else {
        console.log("Unsupported file type: " + extname);
      }
    }
  } else {
    console.log("Path not found: " + options.in);
  }
} catch (err) {
  console.log("UH", err);
  yargs.showHelp();
}
//})();

function watchPath(path: string, config: Config) {
  chokidar.watch(path).on("all", (event, path) => {
    //console.log("Change", event, path);
    // TODO: Remove deleted files etc
    if (shouldProcessFile(path)) {
      processFile(path, config);
    }
  });
}

function processFolder(folder: string, config: Config) {
  const dir = fs.opendirSync(folder);
  let dirent;
  while ((dirent = dir.readSync()) !== null) {
    if (shouldProcessFile(dirent.name)) {
      processFile(path.join(folder, dirent.name), config);
      fs.watch;
    }
  }
  dir.closeSync();
}

function shouldProcessFile(filename: string) {
  return path.extname(filename) === SUPPORTED_EXTENSION;
}

function processFile(filename: string, config: Config) {
  console.log("Processing", filename);

  // TODO: Automatic encoding
  const input = fs.readFileSync(filename, "utf8");

  const tokens = tokenize(input);
  console.log("Tokenized");
  const parsed = parse(tokens);
  if (parsed.ok) {
    console.log("Parsed");
  } else {
    console.log("ERRORS");
    for (let error of parsed.errors) {
      console.log(error.i + ": " + error.message);
    }
    return;
  }

  const result = build(parsed.root);
  console.log("Built");
  /*
  if (!result.ok) {
    console.log("ERRORS");
    for (let error of result.errors) {
      console.log(error.i + ": " + error.message);
    }
    return;
  }
  */

  const outfile = path.join(path.dirname(filename), "output.txt");

  fs.writeFileSync(outfile, result.code);
  console.log("Created", outfile);
}
