# Core Module Architecture Rules

## API/Impl Separation Principle

Core modules split into two Gradle modules:
- **api** — public contract: interfaces, sealed interfaces for state, data classes for models
- **impl** — private implementation: classes implementing api interfaces + DI wiring

Feature modules and other core modules depend ONLY on `api`.
Only the app module (composition root) depends on both `api` and `impl`.

## Dependency Direction

```
app --> core:<module>:api + core:<module>:impl
feature:<any> --> core:<module>:api (NEVER impl)
core:<other>:impl --> core:<module>:api (NEVER impl)
```

## Interface Design Rules

1. Interface in api module is always `public` (default visibility)
2. Interface suffix conventions: `Controller`, `Repository`, `Manager`, `Provider`
3. State models (`sealed interface`) belong in api if consumed by feature modules
4. Keep api dependencies minimal — only what's needed for the contract
5. No DI framework dependency in api module (no Hilt, no Koin)

## Hilt Implementation Rules (<your-project>)

1. Implementation class: `@Singleton internal class <Name>Impl @Inject constructor(...)`
2. DI module: `@Module @InstallIn(SingletonComponent::class) internal abstract class <ModuleName>Module`
3. Binding: `@Binds @Singleton internal abstract fun bind<Name>(impl: <Name>Impl): <InterfaceName>`
4. Everything in impl is `internal` — never leak implementation details
5. Convention plugins: `myproject.android.library` (required) + `myproject.android.hilt` (required)
6. Additional plugins as needed: `myproject.android.library.compose`, `myproject.android.room`

## Koin Implementation Rules (KMP)

1. Implementation class: `class <Name>Impl(...) : <InterfaceName>` (no `internal` — Koin does not require it)
2. DI module: `val <moduleName>Module = module { single<InterfaceName> { <Name>Impl(...) } }`
3. For KMP with platform-specific code: `expect fun create<Name>(): <InterfaceName>` + `actual fun` per platform
4. Koin module registered in root `appModule` aggregator
5. No convention plugins — use `kotlinMultiplatform` + `androidLibrary` directly
6. Use `bundles.koin.library` for Koin dependencies in impl

## Package Naming

### <your-project> (Hilt)
- api: `com.example.<moduleName>.api`
- impl: `com.example.<moduleName>.impl`

### KMP example (Koin)
- api: `com.example.myapp.core.<moduleName>.api`
- impl: `com.example.myapp.core.<moduleName>.impl`

## File Organization

### api module
```
src/main/java/.../<moduleName>/api/
    <InterfaceName>.kt           # Main public interface
    model/                       # State/model classes (if needed)
        <Name>State.kt
```

### impl module (Hilt)
```
src/main/java/.../<moduleName>/impl/
    <InterfaceName>Impl.kt       # @Singleton internal implementation
    di/
        <ModuleName>Module.kt    # @Binds abstract class
```

### impl module (Koin/KMP)
```
src/commonMain/kotlin/.../<moduleName>/impl/
    <InterfaceName>Impl.kt       # Implementation
    di/
        <ModuleName>Module.kt    # val xyzModule = module { ... }
```

For KMP with platform-specific code:
```
src/commonMain/kotlin/.../impl/
    <Name>Factory.kt             # expect fun create<Name>(): <InterfaceName>
    di/<ModuleName>Module.kt
src/androidMain/kotlin/.../impl/
    Android<Name>.kt             # Android implementation
    <Name>Factory.android.kt     # actual fun
src/iosMain/kotlin/.../impl/
    Ios<Name>.kt                 # iOS implementation
    <Name>Factory.ios.kt         # actual fun
```

## Common Mistakes

1. **Leaking impl dependency**: Feature module imports from impl package instead of api
2. **Non-internal impl class (Hilt)**: `@Singleton class Impl` instead of `@Singleton internal class Impl`
3. **Non-internal DI module (Hilt)**: Hilt module class and binding methods must be `internal`
4. **Heavy dependencies in api**: api should have minimal deps (coroutines, models). Heavy libs (Firebase, Play Core, Room) go in impl only
5. **DI framework in api**: No `@Inject`, `@Module`, Koin imports in api module
6. **Missing settings.gradle.kts registration**: Both `:core:<name>:api` and `:core:<name>:impl` must be included
7. **Missing app dependency**: app/build.gradle.kts must depend on both api and impl
8. **Circular dependency**: core modules must not depend on feature modules
