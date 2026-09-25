// Framework-only app: no AndroidX or other runtime libraries, so the APK and its memory footprint stay small.
plugins {
    id("com.android.application") version "9.0.1"
}

android {
    namespace = "io.github.limpy183dev.still"
    compileSdk = 36
    defaultConfig {
        applicationId = "io.github.limpy183dev.still"
        minSdk = 30
        targetSdk = 36
        // The Android preview shares the app version in ../package.json, so each release's APK reports it.
        val appVersion = Regex("\"version\"\\s*:\\s*\"(\\d+)\\.(\\d+)\\.(\\d+)\"").find(file("../package.json").readText())
            ?: error("No x.y.z version in package.json")
        val (major, minor, patch) = appVersion.destructured
        versionCode = major.toInt() * 10000 + minor.toInt() * 100 + patch.toInt()
        versionName = "$major.$minor.$patch"
    }
    // Release signing comes from the environment (set by the release workflow), so the key never lives in the repo.
    val keystore = System.getenv("STILL_KEYSTORE")
    signingConfigs {
        if (keystore != null) create("release") {
            storeFile = file(keystore)
            storePassword = System.getenv("STILL_KEYSTORE_PASSWORD")
            keyAlias = "still"
            keyPassword = System.getenv("STILL_KEYSTORE_PASSWORD")
        }
    }
    buildTypes {
        release {
            if (keystore != null) signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        buildConfig = false
        aidl = false
        shaders = false
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
