package main

import (
	"crypto/md5"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
)

// json-serde-typed: decode the GeoJSON document into structs via
// encoding/json's struct-tag mapping and re-marshal them — the typed
// counterpart to json-serde.go's map[string]interface{} DOM decode. The path
// argument is used as-is (the early version appended ".json", so the
// harness's full filename silently read nothing and hashed empty structs).

func main() {
	fileName := "bench/sample.json"
	n := 10
	if len(os.Args) > 1 {
		fileName = os.Args[1]
	}
	if len(os.Args) > 2 {
		n, _ = strconv.Atoi(os.Args[2])
	}
	jsonStr, err := os.ReadFile(fileName)
	if err != nil {
		panic("read failed: " + err.Error())
	}
	var data GeoData
	if err := json.Unmarshal(jsonStr, &data); err != nil {
		panic("parse failed: " + err.Error())
	}
	printHash(toJson(data))
	array := make([]GeoData, 0, n)
	for i := 0; i < n; i++ {
		var d GeoData
		if err := json.Unmarshal(jsonStr, &d); err != nil {
			panic("parse failed: " + err.Error())
		}
		array = append(array, d)
	}
	printHash(toJson(array))
}

func toJson(v interface{}) []byte {
	if bytes, err := json.Marshal(v); err == nil {
		return bytes
	}
	return []byte{}
}

func printHash(json []byte) {
	hasher := md5.New()
	hasher.Write(json)
	fmt.Printf("%x\n", hasher.Sum(nil))
}

type GeoData struct {
	Type     string    `json:"type"`
	Features []Feature `json:"features"`
}

type Feature struct {
	Type       string     `json:"type"`
	Properties Properties `json:"properties"`
	Geometry   Geometry   `json:"geometry"`
}

type Properties struct {
	Name string `json:"name"`
}

type Geometry struct {
	Type        string         `json:"type"`
	Coordinates [][][2]float64 `json:"coordinates"`
}
