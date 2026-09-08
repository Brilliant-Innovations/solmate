-- pgTAP: contemporaneous quote probes are append-only evidence (§18.1 Level B, D48).
begin;
select plan(4);

insert into core.assets (id, mint_address, symbol, name, decimals, token_program, first_observed_at)
values ('22222222-2222-4222-8222-222222222299', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'QP', 'Quote Probe', 6, 'TOKEN', now());

insert into market.quote_probes (id, asset_id, provider, purpose, input_mint, output_mint, input_amount, expected_output_amount, min_output_amount, price_impact_bps, slippage_bps, quoted_at)
values ('99999999-9999-4999-8999-999999999901', '22222222-2222-4222-8222-222222222299', 'JUPITER', 'DECISION', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 100000000, 995000, 985050, 20, 100, now());

select is((select count(*)::int from market.quote_probes where id = '99999999-9999-4999-8999-999999999901'), 1, 'a probe is recorded');
select throws_ok(
  $$ update market.quote_probes set expected_output_amount = 1 where id = '99999999-9999-4999-8999-999999999901' $$,
  'P0001', null, 'a probe cannot be edited');
select throws_ok(
  $$ delete from market.quote_probes where id = '99999999-9999-4999-8999-999999999901' $$,
  'P0001', null, 'a probe cannot be deleted');
select throws_ok(
  $$ insert into market.quote_probes (provider, purpose, input_mint, output_mint, input_amount, expected_output_amount, min_output_amount, slippage_bps, quoted_at)
     values ('JUPITER', 'GUESS', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 1, 1, 1, 1, now()) $$,
  '23514', null, 'purpose is a closed vocabulary');

select * from finish();
rollback;
