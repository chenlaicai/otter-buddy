#!/usr/bin/env bash
# 探针目标地址：把 config 里的 server.host 换算成「可以拼进 URL 的主机部分」。
#
# 为什么单独成文件：两个运维脚本（主服务脚本与 alpha 脚本）都要探活，而监听地址是
# 可配置的——探针写死 127.0.0.1 时，配置成 ::1 的实例探活恒失败，alpha 还会据此
# 把刚起来的健康进程当失败清掉。判据必须跟着「服务实际监听在哪」走。
#
# 映射规则：
#   未配置              → 127.0.0.1（服务缺省只绑 IPv4 回环）
#   0.0.0.0 / *         → 127.0.0.1（通配 IPv4 用回环探）
#   :: / [::]           → [::1]   （通配 IPv6 用 IPv6 回环探）
#   ::1 等 IPv6 字面量  → 加方括号（URL 里的 IPv6 必须带括号）
#   其它主机名/IPv4      → 原样

# config_server_host <config 文件>：取 server 段下的 host 值（未配置输出空）
config_server_host() {
  local cfg="$1" line
  [ -f "$cfg" ] || return 0
  line="$(awk '
    /^[A-Za-z][A-Za-z0-9_-]*:/ { in_server = ($0 ~ /^server:/) }
    in_server && /^[[:space:]]+host:[[:space:]]*/ { print; exit }
  ' "$cfg")"
  [ -n "$line" ] || return 0
  line="${line##*host:}"
  printf '%s' "$(printf '%s' "${line%#*}" | tr -d " \t\"'")"
}

# probe_host_for <配置里的监听地址>：输出可拼进 URL 的主机部分
probe_host_for() {
  local host
  host="$(printf '%s' "${1:-}" | tr -d ' \t"')"
  case "$host" in
    ""|0.0.0.0|'*') printf '%s' "127.0.0.1" ;;
    "::"|"[::]")    printf '%s' "[::1]" ;;
    \[*\])          printf '%s' "$host" ;;
    *:*)            printf '[%s]' "$host" ;;
    *)              printf '%s' "$host" ;;
  esac
}
