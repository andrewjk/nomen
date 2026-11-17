package main

import (
	"crypto/md5"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
)

// json-serde (untyped): parse the GeoJSON document into generic
// map[string]interface{} trees and re-marshal them — the DOM counterpart to
// json-serde-typed.go's struct-tag decode. The path argument is used as-is
// (unlike the early versions, which appended ".json" and silently read
// nothing when the harness passed the full filename).

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
	var doc map[string]interface{}
	if err := json.Unmarshal(jsonStr, &doc); err != nil {
		panic("parse failed: " + err.Error())
	}
	printHash(toJson(doc))
	docs := make([]map[string]interface{}, 0, n)
	for i := 0; i < n; i++ {
		var d map[string]interface{}
		if err := json.Unmarshal(jsonStr, &d); err != nil {
			panic("parse failed: " + err.Error())
		}
		docs = append(docs, d)
	}
	printHash(toJson(docs))
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
