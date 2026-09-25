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
        versionCode = 1
        versionName = "0.1.0"
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
