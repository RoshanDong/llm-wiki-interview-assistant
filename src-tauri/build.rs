fn main() {
    configure_macos_native_audio_linking();

    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    let attrs = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attrs).expect("failed to run tauri build script");
}

#[cfg(target_os = "macos")]
fn configure_macos_native_audio_linking() {
    println!("cargo:rustc-link-arg=-mmacosx-version-min=13.0");
    println!("cargo:rustc-link-arg=-Wl,-no_implicit_dylibs");

    if let Ok(output) = std::process::Command::new("xcrun")
        .args(["--sdk", "macosx", "--show-sdk-path"])
        .output()
    {
        if output.status.success() {
            let sdk_path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            println!("cargo:rustc-link-search=framework={sdk_path}/System/Library/Frameworks");
        }
    }

    if let Ok(output) = std::process::Command::new("xcode-select")
        .arg("-p")
        .output()
    {
        if output.status.success() {
            let developer_dir = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let swift_lib = format!("{developer_dir}/usr/lib/swift/macosx");
            println!("cargo:rustc-link-search=native={swift_lib}");
            println!("cargo:rustc-link-arg=-Wl,-rpath,{swift_lib}");
            println!("cargo:rustc-link-lib=static=swiftCompatibility56");
            println!("cargo:rustc-link-lib=static=swiftCompatibilityConcurrency");
            println!("cargo:rustc-link-lib=static=swiftCompatibilityPacks");

            let toolchain_swift_lib =
                format!("{developer_dir}/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/macosx");
            println!("cargo:rustc-link-search=native={toolchain_swift_lib}");
            println!("cargo:rustc-link-arg=-Wl,-rpath,{toolchain_swift_lib}");
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn configure_macos_native_audio_linking() {}
