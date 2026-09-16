//! 统一音乐领域模型（`music.v1`）。
//!
//! 本 crate 的类型全部由 `proto/music/v1` 生成，是整个系统唯一允许的
//! 音乐数据交换结构。任何模块不得自定义与之并行的一套 Note/Pitch 格式。

#[allow(clippy::all)]
#[allow(clippy::pedantic)]
#[allow(missing_docs)]
mod generated {
    tonic::include_proto!("music.v1");
}

/// `music.v1` 包下的全部消息与 gRPC 服务桩。
pub mod v1 {
    pub use super::generated::*;
}

pub use v1::*;
