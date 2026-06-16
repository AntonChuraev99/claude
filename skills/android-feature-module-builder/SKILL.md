---
name: android-feature-module-builder
description: This skill should be used when creating new Android feature modules in multi-module Clean Architecture projects with Jetpack Compose, Hilt DI, and Jetpack Navigation. Triggers on requests like "create a new feature module", "scaffold a new screen", "add a new feature", or when a new screen/module needs to be created following Route/Screen/Content pattern with proper visibility, navigation extensions, and convention plugins.
---

# Android Feature Module Builder

Scaffold complete Android feature modules following Clean Architecture + MVVM conventions with Route/Screen/Content pattern, Hilt DI, and Jetpack Compose Navigation.

## When to Use

- Creating a new feature module from scratch
- Adding a new screen to an existing feature module
- Scaffolding navigation, ViewModel, UiState, and Route for a new screen

## Workflow

### Step 1: Gather Requirements

Before scaffolding, determine:

1. **Feature name** (e.g., `notifications`, `userProfile`) - used for package, module directory, and class prefixes
2. **Screen name(s)** - one feature module may contain multiple screens
3. **Data sources** - which repositories/use cases the ViewModel needs
4. **Navigation parameters** - what arguments the screen receives
5. **Complexity level** - simple (1 screen) vs complex (multiple screens with shared state)

### Step 2: Read Architecture Rules

Read `references/architecture-rules.md` for the full set of architectural constraints, visibility matrix, and naming conventions. This file contains critical rules that MUST be followed.

### Step 3: Read Common Mistakes

Read `references/common-mistakes.md` to understand documented pitfalls. Every mistake listed has occurred in production and caused regressions or MR rejections.

### Step 4: Generate Module Structure

Use template files from `assets/templates/` as the basis. For each file:

1. Read the template
2. Replace all `{{PLACEHOLDER}}` values with actual names
3. Write the file to the correct location in the project

#### Naming Rule

Route, Screen, Content, ViewModel, UiState — **всегда именуются по экрану** (`{{SCREEN_CLASS}}`), НЕ по фиче. Имя фичи (`{{FEATURE_CLASS}}`) используется ТОЛЬКО в Navigation extensions.

#### Placeholder Reference

| Placeholder | Example | Description |
|---|---|---|
| `{{FEATURE_PACKAGE}}` | `notifications` | Lowercase package name |
| `{{FEATURE_CLASS}}` | `Notifications` | PascalCase class prefix (только для Navigation) |
| `{{SCREEN_FOLDER}}` | `notificationsList` | camelCase screen folder name |
| `{{SCREEN_CLASS}}` | `NotificationsList` | PascalCase screen class prefix |
| `{{NAV_ROUTE_CONST}}` | `NavigationConstants.Routes.NotificationsScreens` | Full navigation constant path |

#### Files to Generate

For a single-screen feature module, generate these files in order:

1. **build.gradle.kts** from `assets/templates/build.gradle.kts.template`
   - Location: `features/{{FEATURE_PACKAGE}}/build.gradle.kts`

2. **Navigation** from `assets/templates/FeatureNavigation.kt.template`
   - Location: `features/{{FEATURE_PACKAGE}}/src/main/java/com/example/{{FEATURE_PACKAGE}}/{{FEATURE_CLASS}}Navigation.kt`

3. **UiState** from `assets/templates/FeatureUiState.kt.template`
   - Location: `features/{{FEATURE_PACKAGE}}/src/main/java/com/example/{{FEATURE_PACKAGE}}/ui/screens/{{SCREEN_FOLDER}}/{{SCREEN_CLASS}}UiState.kt`

4. **ViewModel** from `assets/templates/FeatureViewModel.kt.template`
   - Location: `features/{{FEATURE_PACKAGE}}/src/main/java/com/example/{{FEATURE_PACKAGE}}/ui/screens/{{SCREEN_FOLDER}}/{{SCREEN_CLASS}}ViewModel.kt`

5. **Route + Screen** from `assets/templates/FeatureRoute.kt.template`
   - Location: `features/{{FEATURE_PACKAGE}}/src/main/java/com/example/{{FEATURE_PACKAGE}}/ui/screens/{{SCREEN_FOLDER}}/{{SCREEN_CLASS}}Route.kt`
   - Contains Route (internal) + Screen (private) в одном файле

6. **Content** from `assets/templates/FeatureContent.kt.template`
   - Location: `features/{{FEATURE_PACKAGE}}/src/main/java/com/example/{{FEATURE_PACKAGE}}/ui/screens/{{SCREEN_FOLDER}}/{{SCREEN_CLASS}}Content.kt`
   - Отдельный файл — Content (internal) для переиспользования и независимого тестирования

### Step 5: Register Module

After generating files, complete these registration steps:

1. **Add to settings.gradle.kts:**
   ```kotlin
   include(":features:{{FEATURE_PACKAGE}}")
   ```

2. **Add dependency in app/build.gradle.kts:**
   ```kotlin
   implementation(projects.features.{{featurePackageCamelCase}})
   ```

3. **Add route constant** in `features/navigationConstants/` if not already present

4. **Register navigation graph** in `app/.../navigation/AppNavigation.kt`:
   ```kotlin
   {{FEATURE_PACKAGE}}Graph(
       appNavController = navController,
       // ... callbacks
   )
   ```

### Step 6: Validate

After scaffolding, run validation:

```bash
./gradlew :features:{{FEATURE_PACKAGE}}:assembleDebug
```

Verify:
- [ ] Module compiles without errors
- [ ] All composables follow Route/Screen/Content pattern
- [ ] Visibility matrix is correct (Route=internal, Screen=private, Content=private)
- [ ] ViewModel is `@HiltViewModel internal class`
- [ ] UiState is `internal sealed interface`
- [ ] Navigation extensions are public
- [ ] AppScaffold used (NOT Material Scaffold)
- [ ] `when(uiState)` на верхнем уровне Screen — Success ветка вызывает Content напрямую (без AppScaffold)
- [ ] AppScaffold + AppTopBar размещены внутри Content composable, не в Screen
- [ ] No hardcoded colors or font sizes
- [ ] `collectAsStateWithLifecycle` used (NOT `collectAsState`)

## Multi-Screen Feature Modules

For features with multiple screens:

1. Generate each screen in its own subfolder under `ui/screens/`
2. Add all screens to the single `{{FEATURE_CLASS}}Navigation.kt` file
3. If screens share state, place shared ViewModel/UiState in `ui/screens/` (not in a screen subfolder)
4. Create `ui/components/` for feature-internal reusable composables

## Core Module Creation (api/impl)

If the feature requires a new core module (repository, controller, manager) — **use the dedicated skill `/android-core-module-builder`**. It scaffolds `core/<module>/api` + `impl` with the correct api/impl split, DI wiring (Hilt or Koin), placeholders, and registration.

Do not hand-roll the core module inside this skill — the two skills would drift. Key invariant to keep in mind: the feature module depends only on `api`, the app module includes both `api` + `impl`.
