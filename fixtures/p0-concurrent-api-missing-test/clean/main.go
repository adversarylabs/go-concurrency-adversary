package main

// Note: No batchProcessor type here.
// The clean test fixture defines its own instrumented double locally in main_test.go
// to avoid redeclaration with the vulnerable fixture's production type.
// This demonstrates a correct test that proves the serialization guarantee.
