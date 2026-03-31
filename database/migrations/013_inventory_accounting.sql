DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inventory_valuation_method') THEN
    CREATE TYPE inventory_valuation_method AS ENUM ('average', 'fifo');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inventory_tracking_method') THEN
    CREATE TYPE inventory_tracking_method AS ENUM ('periodic', 'perpetual');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'inventory_movement_type') THEN
    CREATE TYPE inventory_movement_type AS ENUM ('purchase', 'sale', 'adjust_in', 'adjust_out');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS inventory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  sku VARCHAR(80),
  name VARCHAR(255) NOT NULL,
  unit VARCHAR(40) NOT NULL DEFAULT 'unit',
  inventory_account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  cogs_account_id UUID NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  revenue_account_id UUID REFERENCES accounts (id) ON DELETE RESTRICT,
  valuation_method inventory_valuation_method NOT NULL DEFAULT 'average',
  tracking_method inventory_tracking_method NOT NULL DEFAULT 'perpetual',
  on_hand_qty NUMERIC(18,4) NOT NULL DEFAULT 0,
  avg_cost NUMERIC(18,6) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, sku)
);

CREATE INDEX IF NOT EXISTS idx_inventory_items_company ON inventory_items (company_id);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items (id) ON DELETE CASCADE,
  movement_type inventory_movement_type NOT NULL,
  movement_date DATE NOT NULL,
  quantity NUMERIC(18,4) NOT NULL CHECK (quantity > 0),
  unit_cost NUMERIC(18,6),
  reference VARCHAR(120),
  note TEXT,
  transaction_id UUID REFERENCES transactions (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_movements_company_date
  ON inventory_movements (company_id, movement_date);
CREATE INDEX IF NOT EXISTS idx_inventory_movements_item
  ON inventory_movements (item_id);

CREATE TABLE IF NOT EXISTS inventory_fifo_layers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies (id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES inventory_items (id) ON DELETE CASCADE,
  source_movement_id UUID NOT NULL REFERENCES inventory_movements (id) ON DELETE CASCADE,
  layer_date DATE NOT NULL,
  remaining_qty NUMERIC(18,4) NOT NULL CHECK (remaining_qty >= 0),
  unit_cost NUMERIC(18,6) NOT NULL CHECK (unit_cost >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_fifo_layers_item_date
  ON inventory_fifo_layers (item_id, layer_date, created_at);
