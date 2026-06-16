---
name: gradle-deps-update
description: This skill should be used when updating Gradle dependencies in Android or KMP projects. Triggers on requests like "update dependencies", "upgrade libs", "update gradle", "bump versions", "check for dependency updates", or when the user wants to update specific or all dependencies in libs.versions.toml. Covers version catalogs, BOM management, convention plugins, compatibility checks, and mandatory Gradle sync verification.
---

# Gradle Dependencies Update

Update Gradle dependencies in Android and KMP multi-module projects safely, ensuring build integrity after every change.

## Supported Project Structures

- **Version Catalogs** (`gradle/libs.versions.toml`) -- primary version source
- **Convention Plugins** (`build-logic/`) -- may override or constrain versions
- **BOM dependencies** (Compose BOM, Firebase BOM) -- manage transitive versions
- **Inline hardcoded versions** in `build.gradle.kts` files -- secondary targets

## Workflow

### Step 1: Discover Project Structure

1. Find the project root: locate `settings.gradle.kts` or `settings.gradle`
2. Read `gradle/libs.versions.toml` -- this is the single source of truth for versions
3. Read `gradle/wrapper/gradle-wrapper.properties` for Gradle wrapper version
4. Check for `build-logic/` or `buildSrc/` directories -- convention plugins may reference catalog versions
5. Scan `build.gradle.kts` files for inline hardcoded dependency versions not in the TOML

### Step 2: Determine Update Scope

Ask the user if not clear:
- **All dependencies** -- full update pass
- **Specific group** -- e.g. "only Compose", "only Firebase", "only Kotlin"
- **Specific library** -- e.g. "update Room to latest"
- **Security patches only** -- minor/patch versions, no major bumps

### Step 3: Find Current Versions

To find the latest stable versions, consult `references/version-sources.md` in this skill directory. Key approach:

1. Use `WebSearch` or `WebFetch` to check the sources listed in the reference file
2. For Google/AndroidX libraries, prefer the Google Maven Repository
3. For Kotlin/JetBrains libraries, check the JetBrains releases page
4. For third-party libraries, check Maven Central or the library's GitHub releases
5. Always prefer **stable** releases unless the user explicitly requests alpha/beta/RC

### Step 4: Check Compatibility

Before applying updates, verify compatibility constraints from `references/compatibility-matrix.md`:

- **Kotlin + KSP**: KSP version must match the Kotlin version prefix (e.g., Kotlin `2.3.0` requires KSP `2.3.x`)
- **Kotlin + Compose Compiler**: since Kotlin 2.0, the Compose compiler plugin version equals the Kotlin version
- **AGP + Gradle**: each AGP version requires a minimum Gradle version (see compatibility table)
- **Compose BOM**: when using a BOM, do NOT set individual Compose library versions -- the BOM manages them
- **Firebase BOM**: same rule -- individual Firebase libraries should not have explicit versions
- **Compose Multiplatform + Kotlin**: specific KMP Compose versions require specific Kotlin versions

### Step 5: Apply Updates

1. Edit `gradle/libs.versions.toml` -- update the `[versions]` section
2. If inline hardcoded versions exist in `build.gradle.kts` files, update those too
3. If convention plugins reference versions, verify they still align
4. For Gradle wrapper updates, run: `./gradlew wrapper --gradle-version=<version>`

**Update order matters** -- apply in this sequence to avoid cascading errors:
1. Gradle wrapper (if needed)
2. AGP (Android Gradle Plugin)
3. Kotlin + KSP
4. Compose BOM / Compose Multiplatform
5. AndroidX libraries
6. Firebase BOM
7. Third-party libraries (Hilt/Koin, Retrofit/Ktor, Room, etc.)
8. Test dependencies

### Step 6: Gradle Sync (MANDATORY)

After applying updates, run Gradle sync to verify the build resolves correctly:

```bash
cd <project-root> && ./gradlew --no-daemon dependencies --configuration releaseRuntimeClasspath 2>&1 | head -100
```

If the project has multiple app modules, check the main one first (typically `:app` or `:composeApp`).

For a faster check, use:
```bash
cd <project-root> && ./gradlew --no-daemon :app:dependencies --configuration releaseRuntimeClasspath 2>&1 | tail -50
```

### Step 7: Build Verification (MANDATORY)

Run a full build to catch compile-time issues:

```bash
cd <project-root> && ./gradlew --no-daemon assembleDebug 2>&1 | tail -80
```

For KMP projects, also verify shared code compiles:
```bash
cd <project-root> && ./gradlew --no-daemon :composeApp:compileKotlinAndroid 2>&1 | tail -80
```

### Step 8: Error Resolution

If the build fails after updates:

1. **Read the full error** -- identify which dependency or API change caused it
2. **Common causes and fixes:**
   - **Removed/renamed API**: check the library's migration guide or changelog
   - **Version conflict**: check for BOM vs explicit version clash; remove explicit version if BOM manages it
   - **KSP version mismatch**: align KSP with Kotlin version
   - **Gradle version too low for AGP**: update Gradle wrapper first
   - **Deprecated API warnings becoming errors**: fix deprecated usage or add `@Suppress` temporarily
3. **Fix the code**, then re-run build verification (Step 7)
4. **Repeat** until build passes cleanly

### Step 9: Report

After successful update, output a summary:

| Dependency | Old Version | New Version | Notes |
|---|---|---|---|
| ... | ... | ... | ... |

Flag any:
- Major version bumps (potential breaking changes)
- Libraries left at old versions (with reason)
- Deprecation warnings observed during build
