use serde::{Deserialize, Serialize};
use std::fs;

// json-serde-typed: decode the GeoJSON document into serde-derived structs
// and re-serialize them — the typed counterpart to json-serde1.rs's
// serde_json::Value DOM decode. The path argument is used as-is.

#[derive(Deserialize, Serialize)]
struct Properties {
    name: String,
}

#[derive(Deserialize, Serialize)]
struct Geometry {
    #[serde(rename = "type")]
    kind: String,
    coordinates: Vec<Vec<[f64; 2]>>,
}

#[derive(Deserialize, Serialize)]
struct Feature {
    #[serde(rename = "type")]
    kind: String,
    properties: Properties,
    geometry: Geometry,
}

#[derive(Deserialize, Serialize)]
struct GeoData {
    #[serde(rename = "type")]
    kind: String,
    features: Vec<Feature>,
}

fn main() -> anyhow::Result<()> {
    let file_name = std::env::args_os()
        .nth(1)
        .and_then(|s| s.into_string().ok())
        .unwrap_or("sample.json".to_string());
    let n: usize = std::env::args_os()
        .nth(2)
        .and_then(|s| s.into_string().ok())
        .and_then(|s| s.parse().ok())
        .unwrap_or(10);
    let json_str = fs::read_to_string(&file_name)?;
    let data: GeoData = serde_json::from_str(&json_str)?;
    print_hash(serde_json::to_vec(&data)?);
    let mut array = Vec::with_capacity(n);
    for _i in 0..n {
        let data: GeoData = serde_json::from_str(&json_str)?;
        array.push(data);
    }
    print_hash(serde_json::to_vec(&array)?);
    Ok(())
}

fn print_hash(bytes: impl AsRef<[u8]>) {
    let digest = md5::compute(&bytes);
    println!("{:x}", digest);
}
