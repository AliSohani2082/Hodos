#!/usr/bin/env node
// `hodos` command: course authoring tools (see lib/cli.js).
import { runCli } from '../lib/cli.js'

process.exitCode = await runCli(process.argv.slice(2))
