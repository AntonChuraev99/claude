# Common Mistakes - Prevention Guide

Every mistake below has occurred in production and caused MR rejections, regressions, or performance issues.

## CRITICAL: Architecture Violations

### 1. ViewModel accessed outside Route

**Wrong:** Screen or Content composable receives or calls ViewModel directly.

```kotlin
// WRONG
@Composable
private fun FeatureScreen(viewModel: FeatureViewModel) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
}
```

**Correct:** Only Route touches ViewModel. Screen/Content receive state and lambdas.

```kotlin
// CORRECT
@Composable
internal fun FeatureRoute(viewModel: FeatureViewModel = hiltViewModel()) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    FeatureScreen(state = state, onAction = viewModel::onAction)
}

@Composable
private fun FeatureScreen(state: FeatureUiState, onAction: (Action) -> Unit) { ... }
```

### 2. Bottom sheet state inside Content

**Wrong:** `rememberModalBottomSheetState` and visibility flags inside Content composable.

**Correct:** Sheet state in Screen, Content receives only `onOpenSheet` callback. See architecture-rules.md "Bottom Sheets Rule".

### 3. Missing Route/Screen/Content separation

**Wrong:** Single composable that does everything - ViewModel, state handling, UI.

**Correct:** Three composables in one file: Route (internal), Screen (private), Content (private).

### 4. Wrong visibility modifiers

**Wrong:** Public ViewModel, public Route composable, public UiState.

**Correct:** Follow the visibility matrix strictly. Only Navigation extensions are public.

## HIGH: Component Misuse

### 5. AppErrorContainer / AppScreenLoadProgressBar inside AppScaffold

**Wrong:** `when(uiState)` внутри `AppScaffold` — `AppErrorContainer` и `AppScreenLoadProgressBar` имеют собственный scaffold, что дублирует `AppTopBar`.

```kotlin
// WRONG — дублируется AppTopBar
AppScaffold(topBar = { AppTopBar(...) }) {
    when (uiState) {
        Loading -> AppScreenLoadProgressBar()   // имеет свой scaffold
        Error   -> AppErrorContainer(...)       // имеет свой scaffold
        Success -> FeatureContent(...)
    }
}
```

**Correct:** `when(uiState)` на верхнем уровне Screen. `AppScaffold` — внутри Content composable:

```kotlin
// CORRECT — Screen
when (uiState) {
    Loading -> AppScreenLoadProgressBar()
    Error   -> AppErrorContainer(onBackPressed = onBackPressed, error = uiState.exception)
    Success -> FeatureContent(state = uiState, onBackPressed = onBackPressed)
}

// CORRECT — Content владеет AppScaffold
@Composable
private fun FeatureContent(
    state: FeatureUiState.Success,
    onBackPressed: () -> Unit,
) {
    AppScaffold(topBar = { AppTopBar(onBackPressed = onBackPressed, ...) }) {
        // UI
    }
}
```

### 5a. Material Scaffold instead of AppScaffold

**Wrong:**
```kotlin
import androidx.compose.material3.Scaffold
Scaffold(modifier = ...) { paddingValues -> ... }
```

**Correct:**
```kotlin
import com.example.designsystem.component.containers.AppScaffold
AppScaffold(topBar = { AppTopBar(...) }) { ... }
```

AppScaffold handles systemBarsPadding automatically. Material Scaffold does not.

### 6. Hardcoded colors and font sizes

**Wrong:** `Color.White`, `Color(0xFF...)`, `fontSize = 18.sp`

**Correct:** `AppTheme.colorScheme.textPrimary`, `AppTheme.typography.HeadersH3`

### 7. Duplicate components

Before creating any UI component, search `core/designsystem/` and `core/ui/` for existing ones. Common duplications:
- Custom buttons (use `AppButton` with `AppButtonStyle`)
- Custom top bars (use `AppTopBar`)
- Custom loading indicators (use `AppScreenLoadProgressBar`)
- Custom image loading (use `AppLoadedImage`)
- Custom error views (use `AppErrorContainer`)

## MEDIUM: State Management

### 8. collectAsState instead of collectAsStateWithLifecycle

**Wrong:** `val state by viewModel.uiState.collectAsState()`

**Correct:** `val state by viewModel.uiState.collectAsStateWithLifecycle()`

`collectAsState` continues collecting when app is in background, wasting resources.

### 9. Missing @Immutable on state classes

**Wrong:**
```kotlin
data class Success(val items: ImmutableList<Item>) : UiState()
```

**Correct:**
```kotlin
@Immutable
data class Success(val items: ImmutableList<Item>) : UiState()
```

Without `@Immutable`, Compose cannot skip recomposition for unchanged states.

### 10. Loading data in ViewModel init

**Wrong:**
```kotlin
init {
    viewModelScope.launch { repository.loadItems() }
}
```

**Correct:** Data loading happens in Repository via `flow { }.stateIn(scope, SharingStarted.Lazily, ...)`. ViewModel combines repository flows.

### 11. UiState inside ViewModel file

For complex screens, UiState belongs in a separate `<ScreenName>UiState.kt` file. Only simple screens (2-3 state fields) may define state inline in the ViewModel file.

## LOW: Naming and Structure

### 12. Wrong file naming

**Wrong:** `FeatureScreen.kt` (file named after Screen composable)

**Correct:** `FeatureRoute.kt` (file named after Route - the entry point)

### 12a. Route/UiState named by feature instead of screen

**Wrong:** `NotificationsRoute`, `NotificationsUiState` (по имени фичи, если экран — список)

**Correct:** `NotificationsListRoute`, `NotificationsListUiState` (по имени конкретного экрана)

Имя фичи (`Notifications`) используется ТОЛЬКО в Navigation extensions: `navigateToNotifications()`, `notificationsGraph()`. Все остальные классы именуются по экрану.

### 12b. Content in same file as Route/Screen

**Wrong:** Route, Screen, Content — все три composable в одном файле `*Route.kt`.

**Correct:** Route + Screen в `<ScreenName>Route.kt`, Content — в отдельном `<ScreenName>Content.kt` (internal visibility). Это позволяет переиспользовать Content и тестировать независимо от Route/Screen.

### 12c. Hardcoded Loading/Error UI instead of design system components

**Wrong:** Custom `CircularProgressIndicator()` или ручная вёрстка ошибки в Screen.

**Correct:** Использовать компоненты дизайн-системы: `AppScreenLoadProgressBar` для Loading, `AppErrorContainer` для Error. Если подходящего компонента нет — сначала создать его в `core/designsystem/`, а не хардкодить UI в Screen.

### 13. Wrong folder casing

**Wrong:** `ui/screens/FeatureName/`, `ui/screens/feature_name/`

**Correct:** `ui/screens/featureName/` (camelCase)

### 14. Use cases in feature module

**Wrong:** Business logic use case class in `features/<feature>/usecase/`

**Correct:** Use cases in `core/data/usecase/`. Feature modules only contain UI layer.

### 15. Components in wrong location

**Wrong:** `features/<feature>/components/`, `features/<feature>/views/`

**Correct:** `features/<feature>/ui/components/` - always under `ui/`

## Performance

### 16. ExoPlayer listener accumulation

When using ExoPlayer in composables, wrap listener management in `DisposableEffect`:

```kotlin
DisposableEffect(player) {
    val listener = object : Player.Listener { ... }
    player.addListener(listener)
    onDispose { player.removeListener(listener) }
}
```

Without `DisposableEffect`, listeners accumulate on every recomposition.

### 17. Bitmap not recycled after ML Kit

After ML Kit face detection or classification, always recycle the bitmap:

```kotlin
try {
    val result = faceDetector.process(inputImage).await()
    // process result
} finally {
    bitmap.recycle()
}
```

### 18. FaceDetector recreated per operation

`FaceDetector` from ML Kit must be a Singleton. Recreating it per operation wastes memory and initialization time.

## Database

### 19. Room autoGenerate PK + REPLACE = silent duplicates

When using `@PrimaryKey(autoGenerate = true)` with `OnConflictStrategy.REPLACE`, Room creates new rows instead of replacing. Paginated data multiplies N times (N = number of pages fetched).

**Fix:** Use natural keys or `OnConflictStrategy.IGNORE` + manual update.
