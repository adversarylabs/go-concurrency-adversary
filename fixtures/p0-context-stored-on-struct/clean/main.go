package sample

import "context"

type Client struct {
	addr string
}

func (c *Client) Fetch(ctx context.Context) error {
	return call(ctx)
}

func Dial(ctx context.Context, addr string) (*Client, error) {
	_ = ctx
	return &Client{addr: addr}, nil
}

func call(context.Context) error { return nil }
