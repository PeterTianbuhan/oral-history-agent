#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${JAVA_HOME:-}" ]]; then
  if [[ -x "/opt/homebrew/opt/openjdk@21/bin/java" ]]; then
    export JAVA_HOME="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
  elif java_home_path="$(/usr/libexec/java_home -v 21 2>/dev/null)"; then
    export JAVA_HOME="$java_home_path"
  fi
fi

if [[ -z "${ANDROID_HOME:-}" && -d "/opt/homebrew/share/android-commandlinetools" ]]; then
  export ANDROID_HOME="/opt/homebrew/share/android-commandlinetools"
fi

if [[ ! -x "${JAVA_HOME:-}/bin/java" ]]; then
  echo "Android 构建需要 JDK 21。请先设置 JAVA_HOME。" >&2
  exit 1
fi

if [[ -z "${ANDROID_HOME:-}" || ! -d "$ANDROID_HOME" ]]; then
  echo "没有找到 Android SDK。请先设置 ANDROID_HOME。" >&2
  exit 1
fi

cd "$project_dir"
npm run android:sync
./android/gradlew -p android assembleDebug
