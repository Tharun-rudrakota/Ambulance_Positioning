"""
Automated Test Suite for Andhra Pradesh Ambulance Optimization System.
Validates dataset integrity, mathematical optimization solvers,
dispatch simulator, and API endpoints.
"""
import unittest
import os
import sys
import json

# Add project root to sys.path
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from src.algorithms.distance_matrix import (
    haversine_km, estimate_road_distance, estimate_travel_time_minutes
)
from src.algorithms.mclp import MCLPSolver
from src.algorithms.p_median import PMedianSolver
from src.algorithms.hybrid_optimizer import HybridAmbulanceOptimizer
from src.simulation.dispatch_engine import DispatchEngine
from src.simulation.golden_hour_evaluator import GoldenHourEvaluator
from src.api.app import app, DATA_CACHE, load_data

class TestAPAmbulanceOptimizer(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        app.config['TESTING'] = True
        app.testing = True
        load_data()

    def test_01_dataset_integrity(self):
        """Verify all 26 districts and 679 mandals of Andhra Pradesh."""
        districts = DATA_CACHE.get("districts", [])
        mandals = DATA_CACHE.get("mandals", [])
        blackspots = DATA_CACHE.get("blackspots", [])

        self.assertEqual(len(districts), 26, f"Expected 26 districts, got {len(districts)}")
        self.assertEqual(len(mandals), 679, f"Expected 679 mandals, got {len(mandals)}")
        self.assertGreater(len(blackspots), 100, f"Expected >100 blackspots, got {len(blackspots)}")

        # Geographic boundary sanity check for Andhra Pradesh (Lat: 12.6 to 19.5, Lng: 76.5 to 85.0)
        for m in mandals:
            self.assertTrue(12.5 <= m["lat"] <= 19.5, f"Mandal {m['mandal_name']} lat {m['lat']} out of AP bounds")
            self.assertTrue(76.5 <= m["lng"] <= 85.0, f"Mandal {m['mandal_name']} lng {m['lng']} out of AP bounds")

    def test_02_distance_and_eta_calculations(self):
        """Test Haversine and road network distance and ETA estimations."""
        # Distance between Vijayawada (16.5062, 80.6480) and Guntur (16.3067, 80.4365) ~ 31 km
        straight_dist = haversine_km(16.5062, 80.6480, 16.3067, 80.4365)
        self.assertTrue(25.0 <= straight_dist <= 38.0, f"Unexpected straight distance: {straight_dist}")

        road_dist = estimate_road_distance(16.5062, 80.6480, 16.3067, 80.4365, "National Highway")
        self.assertGreater(road_dist, straight_dist, "Road distance should include circuity factor")

        eta = estimate_travel_time_minutes(16.5062, 80.6480, 16.3067, 80.4365, "National Highway")
        self.assertGreater(eta, 0.0)
        self.assertLess(eta, 60.0)

    def test_03_mclp_solver(self):
        """Test Maximal Covering Location Problem solver."""
        # Use Guntur mandals as a test case
        guntur_mandals = [m for m in DATA_CACHE["mandals"] if m["district"] == "Guntur"]
        self.assertGreater(len(guntur_mandals), 0)

        demands = [{
            "id": m["mandal_id"], "name": m["mandal_name"],
            "lat": m["lat"], "lng": m["lng"], "weight": m.get("demand_weight", 1.0)
        } for m in guntur_mandals]

        candidates = [{
            "id": f"CAND-{m['mandal_id']}", "name": m["mandal_name"],
            "lat": m["lat"], "lng": m["lng"], "mandal": m["mandal_name"], "district": "Guntur"
        } for m in guntur_mandals]

        solver = MCLPSolver(demands, candidates, radius_km=15.0)
        res = solver.solve(p_ambulances=8)

        self.assertEqual(len(res["selected_stations"]), 8)
        self.assertGreater(res["node_coverage_pct"], 50.0, "8 ambulances with 15km radius should cover >50% of Guntur")
        self.assertGreater(res["weighted_coverage_pct"], 50.0)

    def test_04_p_median_solver(self):
        """Test p-Median response time minimization solver."""
        krishna_mandals = [m for m in DATA_CACHE["mandals"] if m["district"] == "Krishna"]
        self.assertGreater(len(krishna_mandals), 0)

        demands = [{
            "id": m["mandal_id"], "name": m["mandal_name"],
            "lat": m["lat"], "lng": m["lng"], "weight": m.get("demand_weight", 1.0)
        } for m in krishna_mandals]

        candidates = [{
            "id": f"CAND-{m['mandal_id']}", "name": m["mandal_name"],
            "lat": m["lat"], "lng": m["lng"], "mandal": m["mandal_name"], "district": "Krishna"
        } for m in krishna_mandals]

        solver = PMedianSolver(demands, candidates)
        res = solver.solve(p_ambulances=10)

        self.assertEqual(len(res["selected_stations"]), 10)
        self.assertLess(res["average_response_time_minutes"], 25.0)
        self.assertGreater(res["golden_hour_compliance_pct"], 50.0)

    def test_05_dispatch_engine(self):
        """Test live incident dispatch and route calculation."""
        test_stations = [
            {"station_id": "AMB-01", "name": "Vijayawada Center", "lat": 16.5062, "lng": 80.6480, "district": "NTR", "mandal": "Vijayawada", "allocated_vehicle_type": "ALS"},
            {"station_id": "AMB-02", "name": "Mangalagiri Base", "lat": 16.4382, "lng": 80.5631, "district": "Guntur", "mandal": "Mangalagiri", "allocated_vehicle_type": "BLS"}
        ]
        engine = DispatchEngine(test_stations)

        # Accident near Mangalagiri (16.4400, 80.5650)
        dispatch_result = engine.dispatch_nearest_ambulance(16.4400, 80.5650, severity="Critical")

        self.assertEqual(dispatch_result["dispatched_ambulance"]["station_id"], "AMB-02")
        self.assertLess(dispatch_result["response_metrics"]["estimated_eta_minutes"], 10.0)
        self.assertEqual(dispatch_result["response_metrics"]["golden_hour_status"], "GOLDEN_HOUR_MET")
        self.assertGreater(len(dispatch_result["route_waypoints"]), 2)

    def test_06_flask_api_endpoints(self):
        """Test Flask REST API routes."""
        client = app.test_client()

        # 1. Test index page
        res = client.get("/")
        self.assertEqual(res.status_code, 200)

        # 2. Test get districts
        res = client.get("/api/districts")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["total_districts"], 26)

        # 3. Test get mandals
        res = client.get("/api/mandals?district=Visakhapatnam")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["district"], "Visakhapatnam")
        self.assertEqual(data["count"], 11)

        # 4. Test optimization API
        res = client.post("/api/optimize", json={
            "district": "Visakhapatnam",
            "num_ambulances": 6,
            "radius_km": 10.0,
            "algorithm": "hybrid"
        })
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["status"], "success")
        self.assertEqual(len(data["optimization"]["selected_stations"]), 6)

        # 5. Test dispatch API
        res = client.post("/api/dispatch", json={
            "lat": 17.6868, "lng": 83.2185, "severity": "Critical"
        })
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["status"], "success")
        self.assertIn("dispatched_ambulance", data["dispatch"])

    def test_07_village_apis(self):
        """Test Village dataset coverage and autocomplete search API."""
        villages = DATA_CACHE.get("villages", [])
        self.assertGreaterEqual(len(villages), 10000, f"Expected >=10000 villages, got {len(villages)}")

        client = app.test_client()

        # 1. Test villages endpoint by district
        res = client.get("/api/villages?district=Guntur&limit=50")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["status"], "success")
        self.assertGreater(data["total"], 0)
        self.assertLessEqual(len(data["villages"]), 50)
        self.assertEqual(data["villages"][0]["district"], "Guntur")

        # 2. Test autocomplete search
        res = client.get("/api/search_village?q=kaza")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["status"], "success")
        self.assertGreater(len(data["results"]), 0)
        first_result = data["results"][0]
        self.assertIn("village_name", first_result)
        self.assertIn("mandal", first_result)
        self.assertIn("district", first_result)
        self.assertIn("lat", first_result)
        self.assertIn("lng", first_result)

    def test_08_village_danger_spots_and_place_nearer(self):
        """Test Village Danger Spots API and Place Ambulance Nearer feature."""
        client = app.test_client()

        # 1. Test village danger spots
        res = client.get("/api/village_danger_spots?district=Guntur&limit=20")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["status"], "success")
        self.assertGreater(len(data["danger_spots"]), 0)
        ds = data["danger_spots"][0]
        self.assertIn("hazard_type", ds)
        self.assertIn("severity", ds)
        self.assertIn("lat", ds)
        self.assertIn("lng", ds)

        # 2. Test place ambulance nearer
        res = client.post("/api/place_ambulance_nearer", json={
            "lat": ds["lat"],
            "lng": ds["lng"],
            "location_name": ds["name"],
            "district": "Guntur",
            "mandal": ds["mandal"]
        })
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["status"], "success")
        self.assertIn("station", data)
        self.assertLess(data["dispatch"]["response_metrics"]["road_distance_km"], 2.0)
        self.assertLess(data["dispatch"]["response_metrics"]["estimated_eta_minutes"], 5.0)
        self.assertEqual(data["dispatch"]["response_metrics"]["golden_hour_status"], "GOLDEN_HOUR_MET")

    def test_09_duttalur_nellore_ready_ambulance_and_danger_zones(self):
        """Test SPS Nellore and Duttalur mandal coverage, village danger spots, and automated ready ambulance dispatch."""
        client = app.test_client()

        # 1. Verify Duttalur mandal in SPS Nellore
        res = client.get("/api/mandals?district=SPS+Nellore")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["status"], "success")
        self.assertEqual(data["count"], 38)
        duttalur_mandal = [m for m in data["mandals"] if m["mandal_name"].lower() == "duttalur"]
        self.assertEqual(len(duttalur_mandal), 1)
        self.assertEqual(duttalur_mandal[0]["district"], "SPS Nellore")

        # 2. Verify Duttalur village danger spots in SPS Nellore
        res = client.get("/api/village_danger_spots?district=SPS+Nellore")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["status"], "success")
        duttalur_ds = [ds for ds in data["danger_spots"] if ds["mandal"].lower() == "duttalur"]
        self.assertGreaterEqual(len(duttalur_ds), 14)
        first_ds = duttalur_ds[0]
        self.assertIn("Blackspot", first_ds["hazard_type"])
        self.assertGreater(first_ds["annual_accidents"], 0)

        # 3. Test optimization of SPS Nellore deploys ready stations across all 38 mandals
        res = client.post("/api/optimize", json={
            "district": "SPS Nellore",
            "num_ambulances": 14,
            "radius_km": 12.0,
            "algorithm": "hybrid"
        })
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["status"], "success")
        all_nellore_stations = data["optimization"]["selected_stations"] + data["optimization"]["ready_mandal_stations"]
        self.assertEqual(len(all_nellore_stations), 38)
        duttalur_station = [s for s in all_nellore_stations if s["mandal"].lower() == "duttalur"]
        self.assertEqual(len(duttalur_station), 1)

        # 4. Test automated emergency dispatch at Duttalur danger spot dispatches the local Duttalur ready unit
        res = client.post("/api/dispatch", json={
            "lat": first_ds["lat"],
            "lng": first_ds["lng"],
            "severity": "Critical"
        })
        self.assertEqual(res.status_code, 200)
        disp_data = res.get_json()
        self.assertEqual(disp_data["status"], "success")
        dispatched_amb = disp_data["dispatch"]["dispatched_ambulance"]
        self.assertEqual(dispatched_amb["mandal"], "Duttalur")
        self.assertLess(disp_data["dispatch"]["response_metrics"]["road_distance_km"], 5.0)
        self.assertLess(disp_data["dispatch"]["response_metrics"]["estimated_eta_minutes"], 8.0)
        self.assertEqual(disp_data["dispatch"]["response_metrics"]["golden_hour_status"], "GOLDEN_HOUR_MET")

    def test_10_total_district_details_and_boundary(self):
        """Test Total Selected District details, perimeter boundary hull, and 100% places coverage."""
        client = app.test_client()

        # 1. Test district details endpoint for SPS Nellore
        res = client.get("/api/district_details?district=SPS+Nellore")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["status"], "success")
        self.assertEqual(data["district"], "SPS Nellore")
        self.assertEqual(data["total_mandals"], 38)
        self.assertGreaterEqual(data["total_villages"], 600)
        self.assertGreaterEqual(data["total_danger_spots"], 600)
        self.assertGreater(len(data["boundary_hull"]), 4, "Expected valid convex hull boundary polygon")
        self.assertEqual(len(data["mandals"]), 38)

        # 2. Test 100% village coverage without cut-off
        v_res = client.get("/api/villages?district=SPS+Nellore")
        self.assertEqual(v_res.status_code, 200)
        v_data = v_res.get_json()
        self.assertEqual(v_data["status"], "success")
        self.assertGreaterEqual(len(v_data["villages"]), 600, "Should return 100% of district villages")

        # 3. Test 100% danger spot coverage without cut-off
        ds_res = client.get("/api/village_danger_spots?district=SPS+Nellore")
        self.assertEqual(ds_res.status_code, 200)
        ds_data = ds_res.get_json()
        self.assertEqual(ds_data["status"], "success")
        self.assertGreaterEqual(len(ds_data["danger_spots"]), 600, "Should return 100% of district danger zones")

    def test_11_manual_ambulance_persistence_across_sessions(self):
        """
        Verify that manually placed ambulances are saved to disk,
        persist across server restarts / reloads, remain in the active fleet,
        are recognized by the CAD dispatch engine, and can be deleted.
        """
        client = app.test_client()
        test_lat = 14.8512
        test_lng = 79.4125
        stn_name = "Duttalur Custom 108 Base Station"

        # 1. Post a new manual ambulance placement
        res = client.post("/api/manual_ambulances", json={
            "lat": test_lat,
            "lng": test_lng,
            "name": stn_name,
            "district": "SPS Nellore",
            "mandal": "Duttalur",
            "vehicle_type": "Advanced Life Support (ALS) - Custom Base",
            "radius_km": 12.0
        })
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["status"], "success")
        self.assertIn("ambulance", data)
        station_id = data["ambulance"]["station_id"]
        self.assertEqual(data["ambulance"]["name"], stn_name)
        self.assertEqual(data["ambulance"]["mandal"], "Duttalur")
        self.assertTrue(data["ambulance"]["is_manual"])

        # 2. Verify it is saved in data/ap_manual_ambulances.json on disk
        man_path = os.path.join(BASE_DIR, "data", "ap_manual_ambulances.json")
        self.assertTrue(os.path.exists(man_path))
        with open(man_path, "r", encoding="utf-8") as f:
            disk_stations = json.load(f)
        saved_on_disk = [s for s in disk_stations if s.get("station_id") == station_id]
        self.assertEqual(len(saved_on_disk), 1, "Ambulance must be written to disk immediately")

        # 3. Simulate Server Restart / Page Reload by reloading data from disk
        load_data()
        in_cache = [s for s in DATA_CACHE["manual_ambulances"] if s.get("station_id") == station_id]
        self.assertEqual(len(in_cache), 1, "Ambulance must survive reload into DATA_CACHE")
        in_fleet = [s for s in DATA_CACHE["active_fleet"] if s.get("station_id") == station_id or s.get("ambulance_id") == station_id]
        self.assertGreaterEqual(len(in_fleet), 1, "Ambulance must survive reload into active_fleet")

        # 4. Verify CAD dispatch engine dispatches this newly placed station for an incident at Duttalur
        disp_res = client.post("/api/dispatch", json={
            "lat": test_lat,
            "lng": test_lng,
            "severity": "Critical"
        })
        self.assertEqual(disp_res.status_code, 200)
        disp_data = disp_res.get_json()
        self.assertEqual(disp_data["status"], "success")
        dispatched_amb = disp_data["dispatch"]["dispatched_ambulance"]
        self.assertEqual(dispatched_amb["station_id"], station_id)
        self.assertEqual(dispatched_amb["name"], stn_name)
        self.assertLess(disp_data["dispatch"]["response_metrics"]["road_distance_km"], 0.5)
        self.assertLess(disp_data["dispatch"]["response_metrics"]["estimated_eta_minutes"], 2.0)
        self.assertEqual(disp_data["dispatch"]["response_metrics"]["golden_hour_status"], "GOLDEN_HOUR_MET")

        # 5. Verify GET /api/manual_ambulances returns the station
        get_res = client.get("/api/manual_ambulances?district=SPS+Nellore")
        self.assertEqual(get_res.status_code, 200)
        get_data = get_res.get_json()
        self.assertEqual(get_data["status"], "success")
        found = [s for s in get_data["ambulances"] if s.get("station_id") == station_id]
        self.assertEqual(len(found), 1)

        # 6. Verify DELETE /api/manual_ambulances removes it permanently
        del_res = client.delete(f"/api/manual_ambulances/{station_id}")
        self.assertEqual(del_res.status_code, 200)
        del_data = del_res.get_json()
        self.assertEqual(del_data["status"], "success")

        # Verify removed from disk
        with open(man_path, "r", encoding="utf-8") as f:
            disk_after = json.load(f)
        self.assertEqual(len([s for s in disk_after if s.get("station_id") == station_id]), 0)

    def test_12_role_based_login_system(self):
        """Test Officer (Higher Authority) and Public Citizen authentication."""
        client = app.test_client()

        # 1. Test invalid officer login
        res = client.post("/api/auth/login", json={
            "username": "officer", "password": "wrongpassword", "role": "officer"
        })
        self.assertEqual(res.status_code, 401)

        # 2. Test valid officer login
        res = client.post("/api/auth/login", json={
            "username": "officer", "password": "officer123", "role": "officer"
        })
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["status"], "success")
        self.assertEqual(data["user"]["role"], "officer")

        # 3. Test current_user API returns officer
        res = client.get("/api/auth/current_user")
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertTrue(data["authenticated"])
        self.assertEqual(data["user"]["role"], "officer")
        self.assertTrue(data["user"]["is_officer"])

        # 4. Test public citizen login
        res = client.post("/api/auth/login", json={
            "username": "citizen", "password": "citizen123", "role": "public"
        })
        self.assertEqual(res.status_code, 200)
        data = res.get_json()
        self.assertEqual(data["status"], "success")
        self.assertEqual(data["user"]["role"], "public")

        # 5. Test logout
        res = client.post("/api/auth/logout")
        self.assertEqual(res.status_code, 200)

    def test_13_manual_positioning_restricted_to_officers(self):
        """Test that manual ambulance positioning and deletion are strictly restricted to officers."""
        client = app.test_client()

        # Log in as a public citizen
        login_res = client.post("/api/auth/login", json={
            "username": "citizen", "password": "citizen123", "role": "public"
        })
        self.assertEqual(login_res.status_code, 200)

        # 1. Citizen attempts to manually place an ambulance -> Expect 403 Forbidden
        res = client.post("/api/manual_ambulances", json={
            "lat": 16.312, "lng": 80.451, "name": "Unauthorized Citizen Station"
        })
        self.assertEqual(res.status_code, 403)
        self.assertIn("restricted", res.get_json()["message"].lower())

        # 2. Citizen attempts to place ambulance nearer -> Expect 403 Forbidden
        res = client.post("/api/place_ambulance_nearer", json={
            "lat": 16.312, "lng": 80.451, "location_name": "Unauthorized Nearer Spot"
        })
        self.assertEqual(res.status_code, 403)
        self.assertIn("restricted", res.get_json()["message"].lower())

        # 3. Citizen attempts to delete an ambulance -> Expect 403 Forbidden
        res = client.delete("/api/manual_ambulances/STATION-999")
        self.assertEqual(res.status_code, 403)

        # 4. Officer logs in and places manual ambulance -> Expect 200 Success
        client.post("/api/auth/login", json={
            "username": "officer", "password": "officer123", "role": "officer"
        })
        officer_res = client.post("/api/manual_ambulances", json={
            "lat": 16.312, "lng": 80.451, "name": "Officer Authorized Station"
        })
        self.assertEqual(officer_res.status_code, 200)
        stn_id = officer_res.get_json()["ambulance"]["station_id"]

        # Clean up by deleting as officer
        del_res = client.delete(f"/api/manual_ambulances/{stn_id}")
        self.assertEqual(del_res.status_code, 200)

    def test_14_public_recommendations_and_officer_approval(self):
        """Test that public citizens can recommend ambulance positioning and officers can approve & deploy."""
        client = app.test_client()

        # 1. Public citizen logs in
        client.post("/api/auth/login", json={
            "username": "citizen", "password": "citizen123", "role": "public"
        })

        # 2. Submit ambulance positioning recommendation
        rec_res = client.post("/api/public/recommendations", json={
            "reporter_name": "R. Varma",
            "reporter_phone": "+91 98480 12345",
            "district": "Guntur",
            "mandal": "Mangalagiri",
            "village": "Kaza Highway Junction",
            "lat": 16.4251,
            "lng": 80.5582,
            "reason": "Blind curve on NH-16 with recurring accidents during night transit.",
            "vehicle_type": "Advanced Life Support (ALS)"
        })
        self.assertEqual(rec_res.status_code, 200)
        rec_data = rec_res.get_json()
        self.assertEqual(rec_data["status"], "success")
        rec_id = rec_data["recommendation"]["id"]

        # 3. Verify public citizen cannot approve recommendations -> 403
        res = client.post(f"/api/officer/approve_recommendation/{rec_id}")
        self.assertEqual(res.status_code, 403)

        # 4. Officer logs in
        client.post("/api/auth/login", json={
            "username": "officer", "password": "officer123", "role": "officer"
        })

        # 5. Officer approves recommendation -> converts to real manual ambulance station
        appr_res = client.post(f"/api/officer/approve_recommendation/{rec_id}")
        self.assertEqual(appr_res.status_code, 200)
        appr_data = appr_res.get_json()
        self.assertEqual(appr_data["status"], "success")
        self.assertEqual(appr_data["recommendation"]["status"], "Approved & Deployed")
        self.assertIn("station", appr_data)
        stn_id = appr_data["station"]["station_id"]

        # Clean up deployed station
        client.delete(f"/api/manual_ambulances/{stn_id}")

    def test_15_public_accident_reporting_and_dispatch(self):
        """Test public citizen accident reporting and emergency dispatch."""
        client = app.test_client()

        # 1. Citizen reports an accident
        acc_res = client.post("/api/public/report_accident", json={
            "reporter_name": "Mohan Rao",
            "reporter_phone": "+91 99887 66554",
            "lat": 16.312,
            "lng": 80.451,
            "location_name": "NH-16 Bypass Pillar 24",
            "district": "Guntur",
            "mandal": "Guntur Rural",
            "severity": "Critical",
            "injured_count": 2,
            "landmark": "Near Toll Plaza",
            "description": "Two-wheeler collided with truck."
        })
        self.assertEqual(acc_res.status_code, 200)
        acc_data = acc_res.get_json()
        self.assertEqual(acc_data["status"], "success")
        self.assertIn("accident", acc_data)
        self.assertIn("dispatch", acc_data)
        acc_id = acc_data["accident"]["id"]

        # 2. View reported accidents list
        list_res = client.get("/api/reported_accidents")
        self.assertEqual(list_res.status_code, 200)
        found = [a for a in list_res.get_json()["accidents"] if a["id"] == acc_id]
        self.assertEqual(len(found), 1)

        # 3. Officer resolves accident
        client.post("/api/auth/login", json={
            "username": "officer", "password": "officer123", "role": "officer"
        })
        res_res = client.post(f"/api/officer/resolve_accident/{acc_id}")
        self.assertEqual(res_res.status_code, 200)
        self.assertEqual(res_res.get_json()["accident"]["status"], "Resolved / Hospitalized")

    def test_16_user_and_officer_registration_system(self):
        """Test registration signup for public citizens and officers without username field."""
        from src.api.app import save_users_to_disk
        # Clean up any leftover test users from earlier runs
        DATA_CACHE["users"] = [
            u for u in DATA_CACHE.get("users", [])
            if u.get("email") not in ("harish_test@example.com", "k.rao_test@ap108.gov.in")
        ]
        save_users_to_disk()

        client = app.test_client()

        try:
            # 1. Register new public citizen without username (only name, email, phone, password)
            res = client.post("/api/auth/register", json={
                "role": "public",
                "name": "K. Harish",
                "email": "harish_test@example.com",
                "phone": "+91 91234 56789",
                "password": "harishpassword123"
            })
            self.assertEqual(res.status_code, 200)
            data = res.get_json()
            self.assertEqual(data["status"], "success")
            self.assertEqual(data["user"]["role"], "public")
            self.assertEqual(data["user"]["phone"], "+91 91234 56789")

            # Verify new citizen cannot manually position ambulance -> 403
            res = client.post("/api/place_ambulance_nearer", json={"lat": 16.3, "lng": 80.4, "location_name": "Test Nearer"})
            self.assertEqual(res.status_code, 403)

            # 2. Register duplicate mobile/email -> Expect 409 Conflict
            res = client.post("/api/auth/register", json={
                "role": "public",
                "name": "Duplicate Harish",
                "email": "harish_test@example.com",
                "phone": "+91 91234 56789",
                "password": "newpassword123"
            })
            self.assertEqual(res.status_code, 409)

            # 3. Officer registration missing officer_id -> Expect 400 Bad Request
            res = client.post("/api/auth/register", json={
                "role": "officer",
                "name": "Officer Test",
                "email": "officer_test@ap108.gov.in",
                "phone": "+91 94401 22334",
                "password": "officerpass123"
            })
            self.assertEqual(res.status_code, 400)

            # 4. Valid officer registration without username (only name, email, phone, officer_id, password)
            res = client.post("/api/auth/register", json={
                "role": "officer",
                "name": "Officer K. Rao",
                "email": "k.rao_test@ap108.gov.in",
                "phone": "+91 94401 99887",
                "officer_id": "AP-CAD-108-99",
                "password": "kraopassword123"
            })
            self.assertEqual(res.status_code, 200)
            data = res.get_json()
            self.assertEqual(data["status"], "success")
            self.assertEqual(data["user"]["role"], "officer")
            self.assertEqual(data["user"]["officer_id"], "AP-CAD-108-99")

            # 5. Verify newly registered officer CAN place manual ambulances
            res = client.post("/api/place_ambulance_nearer", json={"lat": 16.31, "lng": 80.45, "location_name": "Officer Krao Station"})
            self.assertEqual(res.status_code, 200)
            stn_id = res.get_json()["station"]["station_id"]
            client.delete(f"/api/manual_ambulances/{stn_id}")

            # 6. Test login using Mobile Number for Citizen
            res = client.post("/api/auth/login", json={
                "username": "+91 91234 56789",
                "password": "harishpassword123",
                "role": "public"
            })
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.get_json()["user"]["role"], "public")

            # 7. Test login using Officer ID for Officer
            res = client.post("/api/auth/login", json={
                "username": "AP-CAD-108-99",
                "password": "kraopassword123",
                "role": "officer"
            })
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.get_json()["user"]["role"], "officer")

        finally:
            # Cleanup test users created
            DATA_CACHE["users"] = [
                u for u in DATA_CACHE.get("users", [])
                if u.get("email") not in ("harish_test@example.com", "k.rao_test@ap108.gov.in")
            ]
            save_users_to_disk()

if __name__ == "__main__":
    unittest.main()
