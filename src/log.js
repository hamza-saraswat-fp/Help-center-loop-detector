// No logger dependency — console.log/warn/error with a bracketed lane
// prefix, e.g. `[run] starting source=juju`. Keeps Railway log lines
// greppable by lane without pulling in a logging library.

function format(lane, msg) {
  return `[${lane}] ${msg}`;
}

export function log(lane, msg, extra) {
  if (extra === undefined) {
    console.log(format(lane, msg));
  } else {
    console.log(format(lane, msg), extra);
  }
}

export function warn(lane, msg, extra) {
  if (extra === undefined) {
    console.warn(format(lane, msg));
  } else {
    console.warn(format(lane, msg), extra);
  }
}

export function error(lane, msg, extra) {
  if (extra === undefined) {
    console.error(format(lane, msg));
  } else {
    console.error(format(lane, msg), extra);
  }
}
