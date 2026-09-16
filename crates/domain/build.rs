//! 由 proto/music/v1 生成 Rust 类型与 gRPC 客户端/服务端桩。
//! Rust / Python / TypeScript 三端共用同一份 proto，禁止手改生成产物。
fn main() -> Result<(), Box<dyn std::error::Error>> {
    // CARGO_MANIFEST_DIR 指向 crates/domain，proto 在 workspace 根目录
    let proto_root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../proto");
    tonic_build::configure()
        .build_client(true)
        .build_server(true)
        .compile_protos(
            &[
                format!("{proto_root}/music/v1/events.proto"),
                format!("{proto_root}/music/v1/analysis.proto"),
            ],
            &[proto_root],
        )?;
    println!("cargo:rerun-if-changed={proto_root}/music/v1/events.proto");
    println!("cargo:rerun-if-changed={proto_root}/music/v1/analysis.proto");
    Ok(())
}
