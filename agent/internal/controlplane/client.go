package controlplane

import (
	"errors"
	"net/url"
	"strings"
)

type Client struct {
	baseURL *url.URL
}

func New(rawURL string) (*Client, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return nil, errors.New("control-plane client requires an absolute http(s) URL")
	}
	return &Client{baseURL: parsed}, nil
}

func (c *Client) BaseURL() string {
	return c.baseURL.String()
}
