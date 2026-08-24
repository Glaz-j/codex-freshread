#!/bin/sh
set -eu

fail() {
  printf '%s\n' "FreshRead launcher failed: $1" >&2
  # Codex treats hook exit 2 as a blocking error, so a PreToolUse launcher
  # failure cannot silently allow the pending edit.
  exit 2
}

path_is_within() {
  contained_root=$1
  contained_path=$2
  case "$contained_root" in
    /) return 0 ;;
  esac
  case "$contained_path" in
    "$contained_root"|"$contained_root"/*) return 0 ;;
  esac
  return 1
}

physical_existing_path() (
  candidate_path=$1
  candidate_dir=${candidate_path%/*}
  candidate_base=${candidate_path##*/}
  if [ "$candidate_dir" = "$candidate_path" ]; then
    candidate_dir=.
  elif [ -z "$candidate_dir" ]; then
    candidate_dir=/
  fi
  physical_dir=$(CDPATH= cd -P "$candidate_dir" 2>/dev/null && pwd -P) || exit 1
  printf '%s/%s\n' "${physical_dir%/}" "$candidate_base"
)

resolve_executable() (
  executable_path=$1
  link_count=0
  while [ -L "$executable_path" ]; do
    link_count=$((link_count + 1))
    [ "$link_count" -le 32 ] || exit 1
    if [ -x /usr/bin/readlink ]; then
      readlink_bin=/usr/bin/readlink
    elif [ -x /bin/readlink ]; then
      readlink_bin=/bin/readlink
    else
      exit 1
    fi
    link_target=$($readlink_bin "$executable_path") || exit 1
    case "$link_target" in
      /*) executable_path=$link_target ;;
      *)
        link_dir=${executable_path%/*}
        [ "$link_dir" != "$executable_path" ] || link_dir=.
        executable_path=$link_dir/$link_target
        ;;
    esac
  done
  resolved_executable=$(physical_existing_path "$executable_path") || exit 1
  [ -f "$resolved_executable" ] && [ -x "$resolved_executable" ] || exit 1
  printf '%s\n' "$resolved_executable"
)

case ${PLUGIN_ROOT-} in
  /*) ;;
  *) fail "PLUGIN_ROOT must be an absolute path" ;;
esac

workspace=$(pwd -P) || fail "cannot resolve the workspace path"
plugin_root=$(CDPATH= cd -P "$PLUGIN_ROOT" 2>/dev/null && pwd -P) || fail "cannot resolve PLUGIN_ROOT"
hook_script=$plugin_root/scripts/freshread-hook.cjs
[ -f "$hook_script" ] || fail "freshread-hook.cjs is missing"

old_ifs=$IFS
IFS=:
set -f
for path_entry in ${PATH-}; do
  case "$path_entry" in
    /*) ;;
    *) continue ;;
  esac
  resolved_dir=$(CDPATH= cd -P "$path_entry" 2>/dev/null && pwd -P) || continue
  path_is_within "$workspace" "$resolved_dir" && continue
  node_path=$(resolve_executable "$resolved_dir/node") || continue
  path_is_within "$workspace" "$node_path" && continue

  IFS=$old_ifs
  set +f
  # exec preserves stdin/stdout/stderr plus PLUGIN_ROOT and PLUGIN_DATA.
  exec "$node_path" "$hook_script"
done
set +f
IFS=$old_ifs

fail "no trusted node executable was found in an absolute PATH directory outside the workspace"
