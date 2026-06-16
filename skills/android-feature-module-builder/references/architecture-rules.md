# Architecture Rules

## Module Structure

```
features/<feature>/
  src/main/java/com/example/<feature>/
    <Feature>Navigation.kt              # PUBLIC API - only public file
    ui/
      screens/
        <screenName>/                   # camelCase folder per screen
          <ScreenName>Route.kt          # Route (internal) + Screen (private)
          <ScreenName>Content.kt        # Content (internal) — отдельный файл
          <ScreenName>ViewModel.kt      # @HiltViewModel internal class
          <ScreenName>UiState.kt        # internal sealed interface (if complex)
      components/                       # Feature-internal reusable composables
        <ComponentName>.kt
      utils/                            # Optional: helper functions
```

## Naming Rule (CRITICAL)

Route, Screen, Content, ViewModel, UiState — **всегда именуются по экрану** (`<ScreenName>`), НЕ по фиче.

| Правильно | Неправильно |
|-----------|-------------|
| `NotificationsListRoute` | `NotificationsRoute` (если экран — список) |
| `NotificationsListUiState` | `NotificationsUiState` |
| `NotificationsDetailRoute` | `DetailRoute` (нет контекста фичи) |

Имя фичи (`<Feature>`) используется ТОЛЬКО в Navigation extensions: `navigateTo<Feature>()`, `<feature>Graph()`.

## Visibility Matrix (CRITICAL)

| Element | Visibility |
|---------|-----------|
| `NavGraphBuilder.<feature>Graph()` | **public** |
| `NavController.navigateTo<Feature>()` | **public** |
| `<ScreenName>Route()` composable | **internal** |
| `<ScreenName>Screen()` composable | **private** |
| `<ScreenName>Content()` composable | **internal** |
| `@HiltViewModel ViewModel` | **internal** |
| `UiState sealed interface` | **internal** |
| Components in `ui/components/` | **internal** |

## Route/Screen/Content Pattern

**Два файла** per screen:

1. **`<ScreenName>Route.kt`** — содержит Route (internal) + Screen (private)
2. **`<ScreenName>Content.kt`** — содержит Content (internal)

### Route (internal) — в `<ScreenName>Route.kt`
- Receives `ViewModel` via `hiltViewModel()`
- Collects state via `collectAsStateWithLifecycle()`
- Handles side effects: analytics (LaunchedEffect), activity launchers
- Passes state and callbacks down to Screen
- NEVER renders UI directly

### Screen (private) — в `<ScreenName>Route.kt`
- Receives state and callback lambdas (NO ViewModel)
- Wraps content in `AppScaffold` with `AppTopBar`
- Handles `when (uiState)` branching: Loading/Error/Success
- Loading и Error состояния отображать через компоненты дизайн-системы (`AppScreenLoadProgressBar`, `AppErrorContainer`). Если в дизайн-системе нет подходящего компонента — сначала создать его там, а не хардкодить UI в Screen.
- Manages bottom sheet state (`rememberModalBottomSheetState`) as siblings to Content
- Bottom sheet visibility flags declared HERE, not in Content

### Content (internal) — в `<ScreenName>Content.kt`
- Receives only `Success` state and callback lambdas
- Pure UI without state handling
- Does NOT know about bottom sheets, loading, or errors
- Does NOT access ViewModel or side effects
- Отдельный файл, чтобы Content можно было переиспользовать и тестировать независимо от Route/Screen

## Bottom Sheets Rule

Bottom sheets ALWAYS in Screen as siblings to Content:

```kotlin
@Composable
private fun FeatureScreen(state: UiState.Success, onAction: (Action) -> Unit) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var showSheet by remember { mutableStateOf(false) }

    FeatureContent(
        state = state,
        onAction = onAction,
        onOpenSheet = { showSheet = true }
    )

    if (showSheet) {
        AppModalBottomSheet(
            onDismissRequest = { showSheet = false },
            sheetState = sheetState,
        ) { /* sheet content */ }
    }
}
```

## State Management

- `StateFlow<AppResult<T>>` for async states (Success/Error/Loading)
- `ImmutableList` from kotlinx.collections.immutable for collections in state
- `@Immutable` annotation on state data classes
- `collectAsStateWithLifecycle()` (NEVER `collectAsState()`)
- `SharingStarted.WhileSubscribed(5_000)` for ViewModel state flows

## Data Loading Pattern

Load data in Repository with `flow { }.stateIn()`, NOT in ViewModel init:

```kotlin
// Repository
val items: StateFlow<AppResult<ImmutableList<Item>>> = flow {
    emit(AppResult.Loading())
    val result = api.getItems()
    emit(result.map { it.map { it.toDomain() }.toImmutableList() })
}.stateIn(scope, SharingStarted.Lazily, AppResult.Loading())

// ViewModel combines repository flows
val uiState = combine(repository.items, repository.user) { items, user ->
    // map to UiState
}.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), UiState.Loading)
```

## Navigation Pattern

Two public extension functions per feature module:

```kotlin
// Navigate TO feature
fun NavHostController.navigateTo<Feature>() =
    navigate(NavigationConstants.Routes.<Feature>.route)

// Feature navigation graph
fun NavGraphBuilder.<feature>Graph(
    appNavController: NavController,
    // ... navigation callbacks
) {
    composable(route = ...) {
        <Feature>Route(
            onBackPressed = appNavController::popBackStack,
            // ... callbacks
        )
    }
}
```

## Convention Plugins

Feature modules use these plugins:

```kotlin
plugins {
    alias(libs.plugins.myproject.android.feature)          // REQUIRED: auto-includes Hilt, common deps
    alias(libs.plugins.myproject.android.library.compose)   // REQUIRED: Compose setup
}
```

`myproject.android.feature` automatically includes:
- Hilt with KSP
- core:common
- core:models
- core:ui
- core:designsystem
- Navigation dependencies

DO NOT manually add these dependencies - the convention plugin handles them.

## Design System Components (ALWAYS use these)

| Component | Import | Instead Of |
|-----------|--------|------------|
| `AppScaffold` | `designsystem.component.containers.AppScaffold` | Material Scaffold |
| `AppButton` | `designsystem.component.buttons.appButton.AppButton` | Material Button |
| `AppTopBar` | `designsystem.component.topBar.AppTopBar` | Custom top bars |
| `AppIcon` | `designsystem.component.views.AppIcon` | Material Icon |
| `AppLoadedImage` | `designsystem.component.views.loadedImage.AppLoadedImage` | Coil AsyncImage |
| `AppErrorContainer` | `designsystem.component.containers.AppErrorContainer` | Custom error UI |
| `AppScreenLoadProgressBar` | `ui.animations.AppScreenLoadProgressBar` | Custom loaders |

## Theming

ALWAYS use `AppTheme`:

```kotlin
color = AppTheme.colorScheme.textPrimary    // NOT Color.White
style = AppTheme.typography.HeadersH3       // NOT fontSize = 18.sp
```

## Core Module Structure (api/impl)

> Full rules, templates, examples, and checklists for creating core modules are in the `android-core-module-builder` skill (`~/.claude/skills/android-core-module-builder/`).
> Use `/android-core-module-builder` when creating a new core module.

## Error Handling

Use `runCatching` instead of try-catch:

```kotlin
runCatching {
    someDangerousOperation()
}.onFailure { exception ->
    logger.e(TAG, "Operation failed", exception)
}.getOrNull()
```

## Duration Syntax

```kotlin
import kotlin.time.Duration.Companion.hours
private val CACHE_VALIDITY = 48.hours
```

## Comments Policy

No comments unless business logic is non-obvious. No KDoc for simple functions. No inline comments like `// Header`, `// Button`.
