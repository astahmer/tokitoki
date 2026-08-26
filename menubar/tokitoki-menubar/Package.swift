// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "tokitoki-menubar",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "tokitoki-menubar",
            path: "Sources/tokitoki-menubar"
        ),
        .testTarget(
            name: "menubarTests",
            dependencies: ["tokitoki-menubar"],
            path: "Tests/menubarTests"
        ),
    ]
)
