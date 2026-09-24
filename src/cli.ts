#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fetchPods, fetchEvents, KubectlError } from './kubectl';
import { analyzeNamespace } from './analyzer';
import { formatReport } from './formatter';
import type { PodList, EventList } from './k8s-types';

const HELP = `whyfail - explain why your Kubernetes pods are failing

USAGE:
  whyfail [-n <namespace>]
      Analyze a live cluster (shells out to kubectl). Defaults to the
      "default" namespace if -n/--namespace is omitted.

  whyfail --from-file <pods.json> <events.json>
      Analyze exported diagnostics offline - no cluster required.
      <pods.json>   output of: kubectl get pods -n <ns> -o json
      <events.json> output of: kubectl get events -n <ns> -o json

OPTIONS:
  -n, --namespace <ns>   Namespace to inspect in live mode (default: "default")
  --from-file <a> <b>    Analyze pods/events JSON files instead of a live cluster
  -h, --help             Show this help

EXAMPLES:
  whyfail -n production
  whyfail --from-file ./pods.json ./events.json
`;

interface ParsedArgs {
  help: boolean;
  mode: 'live' | 'file';
  namespace: string;
  podsFile?: string;
  eventsFile?: string;
  error?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { help: false, mode: 'live', namespace: 'default' };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        result.help = true;
        break;
      case '-n':
      case '--namespace': {
        const value = argv[++i];
        if (!value) {
          result.error = `${arg} requires a namespace argument`;
          return result;
        }
        result.namespace = value;
        break;
      }
      case '--from-file': {
        const podsFile = argv[++i];
        const eventsFile = argv[++i];
        if (!podsFile || !eventsFile) {
          result.error = '--from-file requires two arguments: <pods.json> <events.json>';
          return result;
        }
        result.mode = 'file';
        result.podsFile = podsFile;
        result.eventsFile = eventsFile;
        break;
      }
      default:
        result.error = `Unrecognized argument: ${arg}`;
        return result;
    }
  }

  return result;
}

function loadJsonFile<T>(path: string): T {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as T;
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const args = parseArgs(argv);

  if (args.error) {
    console.error(`whyfail: ${args.error}`);
    console.error('Run "whyfail --help" for usage.');
    return 1;
  }

  if (args.help) {
    console.log(HELP);
    return 0;
  }

  let podList: PodList;
  let eventList: EventList;

  if (args.mode === 'file') {
    try {
      podList = loadJsonFile<PodList>(args.podsFile!);
      eventList = loadJsonFile<EventList>(args.eventsFile!);
    } catch (err) {
      console.error(`whyfail: failed to read/parse input files: ${(err as Error).message}`);
      return 1;
    }
  } else {
    try {
      podList = fetchPods(args.namespace);
      eventList = fetchEvents(args.namespace);
    } catch (err) {
      if (err instanceof KubectlError) {
        console.error(`whyfail: could not reach a live cluster (${err.message})`);
        console.error('Use --from-file <pods.json> <events.json> to analyze exported diagnostics instead.');
        return 1;
      }
      throw err;
    }
  }

  const results = analyzeNamespace(podList, eventList);
  console.log(formatReport(results, args.mode === 'live' ? args.namespace : undefined));
  return 0;
}

/* istanbul ignore next - only runs when executed directly as a script */
if (require.main === module) {
  process.exitCode = main();
}
