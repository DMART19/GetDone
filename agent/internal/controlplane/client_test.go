package controlplane

import "testing"

func TestNewClientValidatesURLWithoutConnecting(t *testing.T) {
	client, err := New("https://control.example.test")
	if err != nil {
		t.Fatal(err)
	}
	if client.BaseURL() != "https://control.example.test" {
		t.Fatalf("unexpected URL %q", client.BaseURL())
	}
	if _, err := New("relative"); err == nil {
		t.Fatal("relative control-plane URL must fail")
	}
}
