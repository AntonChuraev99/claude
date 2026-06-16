# Dependency Compatibility Matrix

Critical compatibility relationships that MUST be checked when updating dependencies.

## Kotlin + KSP

KSP version must share the same major.minor prefix as the Kotlin version.

| Kotlin | Compatible KSP |
|---|---|
| 2.3.x | 2.3.x (e.g., 2.3.4) |
| 2.2.x | 2.2.x |
| 2.1.x | 2.1.x |
| 2.0.x | 2.0.x |

Find matching KSP: https://github.com/google/ksp/releases
Filter releases by `<kotlin-version>-x.x.x` pattern.

## Kotlin + Compose Compiler

Since Kotlin 2.0, the Compose compiler is a Kotlin compiler plugin. The plugin version equals the Kotlin version.

```kotlin
// In build.gradle.kts or convention plugin
plugins {
    id("org.jetbrains.kotlin.plugin.compose") version "<kotlin-version>"
}
```

No separate `composeCompiler` version is needed -- it follows Kotlin automatically.

## AGP + Gradle Wrapper

Each AGP version has a minimum required Gradle version. Update Gradle wrapper FIRST when bumping AGP.

| AGP Version | Minimum Gradle | Recommended Gradle |
|---|---|---|
| 8.11.x | 8.12 | 8.14+ |
| 8.10.x | 8.11 | 8.14+ |
| 8.9.x | 8.11 | 8.14+ |
| 9.0.x | 9.1 | 9.2+ |
| 9.1.x | 9.2 | 9.3+ |

Always check official compatibility:
https://developer.android.com/build/releases/gradle-plugin#updating-gradle

## Compose BOM (Android-only projects)

When using Compose BOM (`androidx.compose:compose-bom`), do NOT declare individual Compose library versions.

```kotlin
// CORRECT
implementation(platform(libs.compose.bom))
implementation("androidx.compose.ui:ui")           // no version
implementation("androidx.compose.material3:material3") // no version

// WRONG -- will conflict with BOM
implementation(platform(libs.compose.bom))
implementation("androidx.compose.ui:ui:1.7.8")     // explicit version overrides BOM
```

BOM mapping reference: https://developer.android.com/develop/ui/compose/bom/bom-mapping

## Compose Multiplatform + Kotlin (KMP projects)

JetBrains Compose Multiplatform has strict Kotlin version requirements.

| Compose Multiplatform | Required Kotlin |
|---|---|
| 1.9.x | 2.3.0 |
| 1.8.x | 2.1.x |
| 1.7.x | 2.0.x |

Check: https://www.jetbrains.com/help/kotlin-multiplatform-dev/compose-compatibility-and-versioning.html

## Firebase BOM

Same rule as Compose BOM -- do NOT set individual Firebase library versions when using BOM.

```kotlin
// CORRECT
implementation(platform(libs.firebase.bom))
implementation(libs.firebase.analytics)    // no version in TOML

// In libs.versions.toml:
// firebase-analytics = { module = "com.google.firebase:firebase-analytics" }  <-- no version
```

## Room + KSP

Room uses KSP for annotation processing. Room version is independent of KSP version, but KSP must be present and compatible with the Kotlin version.

## Hilt + KSP

Hilt can use KSP instead of kapt since Dagger 2.48+. When using KSP:
- Replace `kapt(libs.hilt.compiler)` with `ksp(libs.hilt.compiler)`
- Remove the `kapt` plugin if no other processors need it

## Kotlin + kotlinx Libraries

kotlinx libraries (coroutines, serialization, datetime, collections-immutable) are generally compatible across Kotlin minor versions, but check release notes for major version bumps.

## Common Pitfalls

1. **Updating Kotlin without KSP** -- build will fail immediately
2. **Updating AGP without Gradle** -- Gradle sync will fail with version requirement error
3. **Mixing BOM and explicit versions** -- leads to classpath conflicts or unexpected versions
4. **Updating Compose Multiplatform without matching Kotlin** -- compile errors in shared module
5. **Updating Hilt without updating KSP** -- annotation processor failures
6. **Legacy ExoPlayer + Media3 coexistence** -- duplicate classes; prefer migrating fully to Media3
