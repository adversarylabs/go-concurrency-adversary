package sample

import (
	"context"
	"log"
)

func consume(ctx context.Context, items []string) error {
	for _, item := range items {
		value, err := fetch(ctx, item)
		if err != nil {
			log.Printf("fetch failed: %v", err)
			continue
		}
		_ = value
	}
	return nil
}

func fetch(context.Context, string) (string, error) { return "", nil }
