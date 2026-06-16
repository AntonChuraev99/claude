# Where to Find Latest Dependency Versions

## Primary Sources

### Google / AndroidX / AGP
- **Google Maven Repository** (authoritative for all `androidx.*`, `com.google.*`):
  https://maven.google.com/web/index.html
  Search by group ID (e.g., `androidx.compose`, `androidx.room`, `com.google.dagger`)
- **AndroidX Release Notes**:
  https://developer.android.com/jetpack/androidx/versions
- **AGP Release Notes** (Android Gradle Plugin):
  https://developer.android.com/build/releases/gradle-plugin
- **Compose BOM Mapping** (which Compose library versions each BOM includes):
  https://developer.android.com/develop/ui/compose/bom/bom-mapping

### Kotlin / KSP / Serialization
- **Kotlin Releases**:
  https://kotlinlang.org/docs/releases.html
- **KSP Releases** (must match Kotlin version prefix):
  https://github.com/google/ksp/releases
- **Kotlinx Serialization**:
  https://github.com/Kotlin/kotlinx.serialization/releases
- **Kotlinx Coroutines**:
  https://github.com/Kotlin/kotlinx.coroutines/releases
- **Kotlinx Datetime**:
  https://github.com/Kotlin/kotlinx-datetime/releases
- **Kotlinx Collections Immutable**:
  https://github.com/Kotlin/kotlinx.collections.immutable/releases

### Compose Multiplatform (KMP)
- **JetBrains Compose Multiplatform Releases**:
  https://github.com/JetBrains/compose-multiplatform/releases
- **Compose-Multiplatform Compatibility**:
  https://www.jetbrains.com/help/kotlin-multiplatform-dev/compose-compatibility-and-versioning.html

### Gradle
- **Gradle Releases**:
  https://gradle.org/releases/
- **Gradle-AGP Compatibility**:
  https://developer.android.com/build/releases/gradle-plugin#updating-gradle

### Firebase
- **Firebase BOM Release Notes**:
  https://firebase.google.com/support/release-notes/android
- **Firebase Android SDK Releases**:
  https://firebase.google.com/docs/android/learn-more#bom

### DI Frameworks
- **Hilt / Dagger Releases**:
  https://github.com/google/dagger/releases
- **Koin Releases**:
  https://github.com/InsertKoinIO/koin/releases

### Networking
- **Retrofit Releases**:
  https://github.com/square/retrofit/releases
- **OkHttp Releases**:
  https://github.com/square/okhttp/releases
- **Ktor Releases**:
  https://github.com/ktorio/ktor/releases

### Database
- **Room** (part of AndroidX, check Google Maven):
  https://developer.android.com/jetpack/androidx/releases/room

### Media
- **Media3 / ExoPlayer** (part of AndroidX):
  https://developer.android.com/jetpack/androidx/releases/media3
- **Coil Releases**:
  https://github.com/coil-kt/coil/releases
- **Glide Releases**:
  https://github.com/bumptech/glide/releases

### Analytics / SDKs
- **RevenueCat Releases**:
  https://github.com/RevenueCat/purchases-android/releases
- **RevenueCat KMP Releases**:
  https://github.com/nicklawls/purchases-kmp/releases
- **Amplitude Android**:
  https://github.com/amplitude/Amplitude-Kotlin/releases
- **AppsFlyer Android**:
  https://github.com/AppsFlyerSDK/appsflyer-android-sdk/releases
- **Facebook Android SDK**:
  https://github.com/facebook/facebook-android-sdk/releases

### Other Common Libraries
- **Lottie Compose**:
  https://github.com/airbnb/lottie-android/releases
- **Detekt**:
  https://github.com/detekt/detekt/releases
- **Mockk**:
  https://github.com/mockk/mockk/releases

## Universal Search

### Maven Central (any library published there)
https://central.sonatype.com/

Search by group:artifact (e.g., `io.insert-koin:koin-core`) to find the latest version.

### Gradle Plugin Portal (for Gradle plugins)
https://plugins.gradle.org/

### GitHub Releases
For any library hosted on GitHub, append `/releases` to the repo URL.
Example: `https://github.com/<owner>/<repo>/releases`

## Using WebSearch for Version Lookup

When using `WebSearch` to find versions, use queries like:
- `<library-name> latest stable version maven`
- `<group-id>:<artifact-id> latest release`
- `site:github.com <library-name> releases`

When using `WebFetch`, fetch the Maven Central API directly:
- `https://central.sonatype.com/artifact/<group-id>/<artifact-id>/versions`
