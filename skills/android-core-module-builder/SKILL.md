---
name: android-core-module-builder
description: This skill should be used when creating new core modules with api/impl architecture in Android or KMP multi-module projects. Triggers on requests like "create a new core module", "add core module", "scaffold core api/impl module", "new core service", "add core controller/repository/manager/provider" with api/impl separation. Supports both Hilt DI (single-platform Android) and Koin DI (Kotlin Multiplatform) projects.
---

# Android Core Module Builder

Generate core modules following the api/impl separation pattern for multi-module Clean Architecture projects. The api module exposes public interfaces and models. The impl module contains internal implementations and DI wiring. Feature modules depend only on api, never on impl.

## Supported Project Types

| Type | DI Framework | Plugins | Example Project |
|------|-------------|---------|----------------|
| **Hilt** | Hilt (Dagger) | Convention plugins (`myproject.android.*`) | <your-project> |
| **Koin** | Koin 4.x | Direct `kotlinMultiplatform` + `androidLibrary` | <your-kmp-project> |

## Workflow

### Step 1: Gather Requirements

Determine the following before generating:

| Requirement | Question | Default |
|------------|----------|---------|
| Module name | Lowercase name for the module (e.g., `appupdate`, `billing`, `notifications`) | Required |
| Interface name | PascalCase interface name (e.g., `AppUpdateController`, `BillingRepository`) | Required |
| Interface suffix | `Controller`, `Repository`, `Manager`, or `Provider` | Infer from name |
| Project type | `hilt` or `koin` -- detect from project's CLAUDE.md or build files | Auto-detect |
| Has state model | Does the api expose a sealed interface state? | No |
| Platform-specific (Koin only) | Does impl need `expect/actual` per platform? | No |
| Extra api deps | Dependencies beyond coroutines needed in api | None |
| Extra impl deps | Heavy dependencies needed in impl (Firebase, Play Core, etc.) | None |

**Auto-detection rules:**
- Project contains `build-logic/` with convention plugins or `myproject.android.*` in build files = **Hilt**
- Project contains `kotlinMultiplatform` plugin or `commonMain` source sets = **Koin**
- If unclear, ask the user

### Step 2: Read Architecture Rules

Read `references/core-module-rules.md` for the complete set of rules governing:
- Dependency direction (api vs impl)
- Visibility modifiers (internal for Hilt, public for Koin)
- Package naming conventions
- File organization patterns
- Common mistakes to avoid

### Step 3: Generate Module Structure

Use templates from `assets/templates/hilt/` or `assets/templates/koin/` based on detected project type.

#### Placeholder Reference

| Placeholder | Example (Hilt) | Example (Koin) | Description |
|-------------|----------------|----------------|-------------|
| `{{MODULE_PACKAGE}}` | `appupdate` | `remoteconfig` | Lowercase module package |
| `{{MODULE_CLASS}}` | `AppUpdate` | `RemoteConfig` | PascalCase module prefix |
| `{{MODULE_PROJECT_PATH}}` | `appupdate` | `remoteconfig` | Gradle project path segment |
| `{{MODULE_CAMEL}}` | `appUpdate` | `remoteConfig` | camelCase for Koin module val |
| `{{INTERFACE_NAME}}` | `AppUpdateController` | `RemoteConfigProvider` | Full interface name |
| `{{STATE_NAME}}` | `AppUpdateState` | -- | State sealed interface name |
| `{{FRAMEWORK_BASE_NAME}}` | -- | `RemoteConfig` | iOS framework base name (Koin only) |
| `{{APP_PACKAGE}}` | -- | `com.example.myapp` | Root app package (Koin only) |
| `{{CONSTRUCTOR_PARAMS}}` | Hilt `@Inject` params | Koin constructor params | Implementation dependencies |
| `{{KOIN_GET_PARAMS}}` | -- | `get(), get()` | Koin `get()` calls for each param |

#### Files Generated (in order)

**For Hilt projects:**

1. `core/{{MODULE_PACKAGE}}/api/build.gradle.kts`
2. `core/{{MODULE_PACKAGE}}/impl/build.gradle.kts`
3. `core/{{MODULE_PACKAGE}}/api/src/main/java/com/example/{{MODULE_PACKAGE}}/api/{{INTERFACE_NAME}}.kt`
4. `core/{{MODULE_PACKAGE}}/impl/src/main/java/com/example/{{MODULE_PACKAGE}}/impl/{{INTERFACE_NAME}}Impl.kt`
5. `core/{{MODULE_PACKAGE}}/impl/src/main/java/com/example/{{MODULE_PACKAGE}}/impl/di/{{MODULE_CLASS}}Module.kt`
6. (Optional) `core/{{MODULE_PACKAGE}}/api/src/main/java/com/example/{{MODULE_PACKAGE}}/api/model/{{STATE_NAME}}.kt`

**For Koin projects:**

1. `core/{{MODULE_PACKAGE}}/api/build.gradle.kts`
2. `core/{{MODULE_PACKAGE}}/impl/build.gradle.kts`
3. `core/{{MODULE_PACKAGE}}/api/src/commonMain/kotlin/.../api/{{INTERFACE_NAME}}.kt`
4. `core/{{MODULE_PACKAGE}}/impl/src/commonMain/kotlin/.../impl/{{INTERFACE_NAME}}Impl.kt`
5. `core/{{MODULE_PACKAGE}}/impl/src/commonMain/kotlin/.../impl/di/{{MODULE_CLASS}}Module.kt`
6. (If platform-specific) `expect/actual` factory files in commonMain, androidMain, iosMain

### Step 4: Register Module

After generating files, perform these registration steps:

#### 4.1 settings.gradle.kts

Add both modules:

```kotlin
include(":core:{{MODULE_PACKAGE}}:api")
include(":core:{{MODULE_PACKAGE}}:impl")
```

Place them alphabetically among existing core module includes.

#### 4.2 app/build.gradle.kts (or composeApp/build.gradle.kts for KMP)

Add dependencies on both api and impl:

**Hilt:**
```kotlin
implementation(projects.core.{{MODULE_PROJECT_PATH}}.api)
implementation(projects.core.{{MODULE_PROJECT_PATH}}.impl)
```

**Koin:**
```kotlin
implementation(projects.core.{{MODULE_CAMEL}}.api)
implementation(projects.core.{{MODULE_CAMEL}}.impl)
```

#### 4.3 Koin Only: Register DI Module

Add the module to the root `appModule` in `composeApp/src/commonMain/.../di/AppModule.kt`:

```kotlin
val appModule = module {
    includes(
        // ... existing modules
        {{MODULE_CAMEL}}Module,
    )
}
```

Import the module val from the impl package.

### Step 5: Validate

Run the following checks:

1. **Compile both modules:**
   ```
   ./gradlew :core:{{MODULE_PACKAGE}}:api:assembleDebug
   ./gradlew :core:{{MODULE_PACKAGE}}:impl:assembleDebug
   ```

2. **Validation checklist:**

| Check | Hilt | Koin |
|-------|------|------|
| api module has NO DI framework imports | Required | Required |
| api module has minimal dependencies | Required | Required |
| impl depends on api | Required | Required |
| Impl class is `internal` | Required | Not required |
| DI module class is `internal` | Required | N/A |
| `@Binds` method is `internal` | Required | N/A |
| Koin module val uses explicit type: `single<Interface>` | N/A | Required |
| settings.gradle.kts includes both modules | Required | Required |
| app depends on both api and impl | Required | Required |
| No feature module depends on impl | Required | Required |
| Interface is public (default visibility) | Required | Required |

## Key Rules Summary

- **api = contract only**: Interfaces, sealed interfaces, data classes. No implementations, no DI.
- **impl = hidden implementation**: Internal classes (Hilt), DI wiring, heavy dependencies.
- **Feature modules see only api**: `implementation(projects.core.<module>.api)` -- never impl.
- **App module wires everything**: Depends on both api and impl as the composition root.
- **Hilt: everything internal in impl**: Class, module, bindings -- all `internal`.
- **Koin: explicit type in single<>**: Always `single<Interface> { Impl() }`, never `single { Impl() }`.
- **No circular deps**: Core modules must not depend on feature modules.
