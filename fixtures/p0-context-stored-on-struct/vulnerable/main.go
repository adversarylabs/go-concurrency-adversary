package sample

import "context"

type Client struct {
	ctx context.Context
}

func (c *Client) Fetch() error {
	return call(c.ctx)
}

func call(context.Context) error { return nil }
